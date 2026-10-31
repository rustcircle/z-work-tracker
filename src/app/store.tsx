// App-wide state: the backend snapshot, a ticking clock and the zones in use. Every backend change
// returns a fresh snapshot, so there is only ever one source of truth.
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';

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

const Ctx = createContext<AppValue | null>(null);

export function useApp(): AppValue {
  const v = useContext(Ctx);
  if (!v) throw new Error('useApp needs AppProvider');
  return v;
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
  const skew = useRef(0);

  const adopt = useCallback((s: Snapshot) => {
    skew.current = parseIso(s.now) * 1000 - Date.now();
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

  useEffect(() => {
    const id = window.setInterval(() => setTick(Date.now()), 1000);
    return () => window.clearInterval(id);
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
  const nowSec = Math.floor((tick + skew.current) / 1000);

  const value = useMemo<AppValue | null>(
    () =>
      snapshot && zones
        ? {
            snapshot,
            nowSec,
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
    [snapshot, zones, nowSec, act, adopt, error, hideNotice],
  );

  if (!value) return <>{fallback(loadError)}</>;
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
