// App-wide state: the backend snapshot, a ticking clock and the zones in use. Every backend change
// returns a fresh snapshot, so there is only ever one source of truth.
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';

import { api, events, type HideNoticePayload } from '../lib/api';
import { applyTheme } from '../lib/themes';
import { isZone, parseIso } from '../lib/tz';
import type { CommandError, Snapshot } from '../lib/types';

export interface Zones {
  /** My zone: the setting, else the system zone. */
  my: string;
  /** Client zone, or null until the user sets one. There is no silent default. */
  client: string | null;
  /** The zone all grouping follows right now. Defaults to My zone. */
  active: string;
  /** "Show both" mode: needs a client zone. */
  showBoth: boolean;
}

/**
 * The page's clock, read without subscribing. Only whoever shows a running clock follows it every second
 * (`useLiveSec`); everything else reads `useApp().nowSec`, which moves once a minute, or `useStepNow`.
 */
export interface ClockApi {
  /** Seconds since the epoch on the backend's clock. */
  readNow: () => number;
  /** False while the window is hidden: nothing should be redrawn for a clock nobody can see. */
  isAwake: () => boolean;
  /** Told when the window goes to sleep (false) or wakes (true). Returns the way to stop listening. */
  subscribe: (listener: (awake: boolean) => void) => () => void;
}

export interface AppValue {
  snapshot: Snapshot;
  /**
   * Seconds since the epoch from the backend's clock, moving once a minute while the window is visible and
   * again whenever new data arrives. A screen that must tick each second uses `useLiveSec`.
   */
  nowSec: number;
  zones: Zones;
  /** Runs a backend call that returns a Snapshot, adopts it, and reports failures as `error`. */
  act: (call: () => Promise<Snapshot>) => Promise<boolean>;
  adopt: (snapshot: Snapshot) => void;
  error: string | null;
  clearError: () => void;
  showError: (message: string) => void;
  hideNotice: HideNoticePayload | null;
  clearHideNotice: () => void;
}

type AppState = Omit<AppValue, 'nowSec'> & { clock: ClockApi };

const Ctx = createContext<AppState | null>(null);
const NowCtx = createContext(0);
const LiveCtx = createContext(0);

/** Everything but the clock. A reader of this one does not re-render on a tick. */
export function useAppState(): AppState {
  const v = useContext(Ctx);
  if (!v) throw new Error('useApp needs AppProvider');
  return v;
}

/** The state and a coarse clock (once a minute and on new data). Use `useAppState` if time isn't shown. */
export function useApp(): AppValue {
  const v = useAppState();
  const nowSec = useContext(NowCtx);
  return { ...v, nowSec };
}

/** The running task's elapsed clock: the one thing that follows the shared 1 s tick. Nothing else should. */
export function useLiveSec(): number {
  return useContext(LiveCtx);
}

function createClock(): ClockApi & { setAwake: (awake: boolean) => void; setSkew: (ms: number) => void; admit: (revision: number) => boolean } {
  let awake = true;
  let skew = 0;
  let newest = -1;
  const listeners = new Set<(awake: boolean) => void>();
  return {
    readNow: () => Math.floor((Date.now() + skew) / 1000),
    // Replies can overtake each other on the way here, so an older snapshot never replaces a newer one.
    admit: (revision) => {
      if (revision < newest) return false;
      newest = revision;
      return true;
    },
    setSkew: (ms) => {
      skew = ms;
    },
    isAwake: () => awake,
    subscribe: (l) => {
      listeners.add(l);
      return () => void listeners.delete(l);
    },
    setAwake: (next) => {
      awake = next;
      for (const l of [...listeners]) l(next);
    },
  };
}

/** Owns the 1 s tick, so that only readers of `useLiveSec` render on it. Stopped while the window is hidden. */
function LiveClock({ clock, children }: { clock: ClockApi; children: ReactNode }) {
  const [sec, setSec] = useState(() => clock.readNow());
  useEffect(() => {
    let timer: number | null = null;
    const start = () => {
      timer ??= window.setInterval(() => setSec(clock.readNow()), 1000);
    };
    const stop = () => {
      if (timer !== null) window.clearInterval(timer);
      timer = null;
    };
    // Started whatever the page says: a webview that loads hidden may not report being shown, and a
    // clock left ticking costs far less than one frozen on screen. The next signal stops it if need be.
    start();
    const off = clock.subscribe((awake) => {
      if (awake) {
        setSec(clock.readNow());
        start();
      } else stop();
    });
    return () => {
      off();
      stop();
    };
  }, [clock]);
  return <LiveCtx.Provider value={sec}>{children}</LiveCtx.Provider>;
}

export function deriveZones(s: Snapshot): Zones {
  const valid = (z: string | null | undefined): string | null => (z && isZone(z) ? z : null);
  const my = valid(s.settings.myZone) ?? valid(s.systemZone) ?? 'UTC';
  const client = valid(s.settings.clientZone);
  return { my, client, active: valid(s.settings.activeZone) ?? my, showBoth: Boolean(s.settings.showBoth) && client !== null };
}

function messageOf(e: unknown): string {
  if (e && typeof e === 'object' && 'message' in e) return String((e as CommandError).message);
  return String(e);
}

export function AppProvider({ children, fallback }: { children: ReactNode; fallback: (error: string | null) => ReactNode }) {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [hideNotice, setHideNotice] = useState<HideNoticePayload | null>(null);
  const [clock] = useState(createClock);
  const [coarse, setCoarse] = useState(() => clock.readNow());

  const adopt = useCallback(
    (s: Snapshot) => {
      if (!clock.admit(s.revision)) return;
      clock.setSkew(parseIso(s.now) * 1000 - Date.now());
      setSnapshot(s);
      // New data: everything derived from the time is worked out afresh.
      setCoarse(clock.readNow());
    },
    [clock],
  );

  useEffect(() => {
    let alive = true;
    const refresh = () =>
      api.getSnapshot().then(
        (s) => {
          if (alive) adopt(s);
        },
        (e: unknown) => {
          if (alive) setLoadError(messageOf(e));
        },
      );
    void refresh();
    const unlisten = [events.onStateChanged(() => void refresh()), events.onFirstHide((p) => setHideNotice(p))];
    return () => {
      alive = false;
      for (const u of unlisten) void u.then((f) => f()).catch(() => undefined);
    };
  }, [adopt]);

  // The clock only runs while someone can see it: the app may sit in the tray all day, and everything
  // that must go on while hidden lives in the backend. Time is read afresh on waking, so nothing is lost.
  // Visibility is read here once and told to every clock (`clock.subscribe`).
  useEffect(() => {
    const sleep = () => clock.setAwake(false);
    const wake = () => clock.setAwake(true);
    const onVisibility = () => (document.visibilityState === 'hidden' ? sleep() : wake());
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('focus', wake);
    // Not every webview reports a hidden window as a hidden page, so the backend says so too.
    const unlisten = [events.onWindowHidden(sleep), events.onWindowShown(wake)];
    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('focus', wake);
      for (const u of unlisten) void u.then((f) => f()).catch(() => undefined);
    };
  }, [clock]);

  // The coarse clock: once a minute while awake, and straight away on waking.
  useEffect(() => {
    let timer: number | null = null;
    const start = () => {
      timer ??= window.setInterval(() => setCoarse(clock.readNow()), 60_000);
    };
    const stop = () => {
      if (timer !== null) window.clearInterval(timer);
      timer = null;
    };
    start();
    const off = clock.subscribe((awake) => {
      if (awake) {
        setCoarse(clock.readNow());
        start();
      } else stop();
    });
    return () => {
      off();
      stop();
    };
  }, [clock]);

  const theme = snapshot?.prefs.theme;
  useEffect(() => {
    applyTheme(theme ?? 'light');
  }, [theme]);

  const act = useCallback(
    async (call: () => Promise<Snapshot>) => {
      try {
        adopt(await call());
        setError(null);
        return true;
      } catch (e) {
        setError(messageOf(e));
        return false;
      }
    },
    [adopt],
  );

  const zones = useMemo(() => (snapshot ? deriveZones(snapshot) : null), [snapshot]);

  const value = useMemo<AppState | null>(
    () =>
      snapshot && zones
        ? {
            snapshot,
            zones,
            act,
            adopt,
            error,
            clearError: () => setError(null),
            showError: setError,
            hideNotice,
            clearHideNotice: () => setHideNotice(null),
            clock,
          }
        : null,
    [snapshot, zones, act, adopt, error, hideNotice, clock],
  );

  if (!value) return <>{fallback(loadError)}</>;
  return (
    <Ctx.Provider value={value}>
      <NowCtx.Provider value={coarse}>
        <LiveClock clock={clock}>{children}</LiveClock>
      </NowCtx.Provider>
    </Ctx.Provider>
  );
}
