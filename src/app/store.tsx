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

export interface AppValue {
  snapshot: Snapshot;
  /** Seconds since the epoch from the backend's clock, ticking every second. */
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

type AppState = Omit<AppValue, 'nowSec'>;

const Ctx = createContext<AppState | null>(null);
const NowCtx = createContext(0);

/** Everything but the clock. A reader of this one does not re-render on a tick. */
export function useAppState(): AppState {
  const v = useContext(Ctx);
  if (!v) throw new Error('useApp needs AppProvider');
  return v;
}

/** The state and the clock: the reader re-renders every second. Use `useAppState` if time isn't shown. */
export function useApp(): AppValue {
  const v = useAppState();
  const nowSec = useContext(NowCtx);
  return { ...v, nowSec };
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
  const [tick, setTick] = useState(() => Date.now());
  const [skew, setSkew] = useState(0);

  const adopt = useCallback((s: Snapshot) => {
    setSkew(parseIso(s.now) * 1000 - Date.now());
    setSnapshot(s);
  }, []);

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

  // The clock only ticks while someone can see it: the app may sit in the tray all day, and everything
  // that must go on while hidden lives in the backend. Time is read afresh on waking, so nothing is lost.
  useEffect(() => {
    let timer: number | null = null;
    const begin = () => {
      timer ??= window.setInterval(() => setTick(Date.now()), 1000);
    };
    const pause = () => {
      if (timer !== null) window.clearInterval(timer);
      timer = null;
    };
    const wake = () => {
      setTick(Date.now());
      begin();
    };
    const onVisibility = () => (document.visibilityState === 'hidden' ? pause() : wake());
    if (document.visibilityState !== 'hidden') begin();
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('focus', wake);
    // Not every webview reports a hidden window as a hidden page, so the backend says so too.
    const unlisten = [events.onWindowHidden(pause), events.onWindowShown(wake)];
    return () => {
      pause();
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('focus', wake);
      for (const u of unlisten) void u.then((f) => f()).catch(() => undefined);
    };
  }, []);

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
  const nowSec = Math.floor((tick + skew) / 1000);

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
          }
        : null,
    [snapshot, zones, act, adopt, error, hideNotice],
  );

  if (!value) return <>{fallback(loadError)}</>;
  return (
    <Ctx.Provider value={value}>
      <NowCtx.Provider value={nowSec}>{children}</NowCtx.Provider>
    </Ctx.Provider>
  );
}
