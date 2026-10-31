// Test fixtures: compact snapshot builders so expected figures can be worked out by hand.
import { parseIso, toIso } from '../../lib/tz';
import type { Project, RateVersion, RoundingVersion, Settings, Segment, ShiftVersion, Snapshot, Task, TaskState } from '../../lib/types';
import { NO_FILTERS, type Params } from './engine';
import type { RangeSpec } from './range';

const stamp = { at: '2026-01-01T00:00:00Z', by: 'dev' };

export interface Spec {
  now: string;
  zone?: string;
  projects?: Partial<Project>[] & { id: string }[];
  tasks?: { id: string; projectId: string; state?: TaskState; stoppedAt?: string | null }[];
  /** [taskId, start, end | null] with ISO UTC times. */
  segs?: [string, string, string | null][];
  shifts?: Partial<ShiftVersion>[];
  rates?: { project: string; cents: number | null; currency?: string; from?: string }[];
  rounding?: Partial<RoundingVersion>[];
  settings?: Settings;
}

export function mkSnapshot(spec: Spec): Snapshot {
  let n = 0;
  return {
    now: spec.now,
    deviceId: 'dev',
    deviceName: 'Test PC',
    systemZone: spec.zone ?? 'UTC',
    tzdbVersion: 'test',
    projects: (spec.projects ?? []).map((p, i) => ({
      id: p.id as string,
      name: p.name ?? (p.id as string),
      color: p.color ?? ['#2563eb', '#dc2626', '#059669', '#d97706'][i % 4] as string,
      archived: false,
      billable: true,
      budgetHours: null,
      clientZone: null,
      createdAt: '2026-01-01T00:00:00Z',
      hasTasks: true,
      ...p,
    })),
    tasks: (spec.tasks ?? []).map(
      (t): Task => ({
        id: t.id,
        name: `Task ${t.id}`,
        projectId: t.projectId,
        description: null,
        state: t.state ?? 'stopped',
        pauseReason: null,
        createdAt: '2026-01-01T00:00:00Z',
        stoppedAt: t.stoppedAt ?? null,
        runningElsewhere: null,
        continuedFrom: null,
      }),
    ),
    segments: (spec.segs ?? []).map(([taskId, start, end]): Segment => {
      n += 1;
      return { id: `s${n}`, taskId, deviceId: 'dev', start, end, provisionalEnd: null };
    }),
    shifts: (spec.shifts ?? []).map(
      (s, i): ShiftVersion => ({
        id: `sv${i}`,
        shiftId: `sh${i}`,
        effectiveFrom: '2026-01-01',
        name: `Shift ${i}`,
        color: '#0891b2',
        start: '09:00',
        end: '13:00',
        weekdays: [1, 2, 3, 4, 5, 6, 7],
        zone: 'UTC',
        breakMinutes: 0,
        retired: false,
        deleted: false,
        stamp,
        ...s,
      }),
    ),
    rates: (spec.rates ?? []).map(
      (r, i): RateVersion => ({ id: `r${i}`, projectId: r.project, effectiveFrom: `${r.from ?? '2026-01-01'}T00:00:00Z`, rateCents: r.cents, currency: r.currency ?? 'EUR', deleted: false, stamp }),
    ),
    rounding: (spec.rounding ?? []).map(
      (r, i): RoundingVersion => ({ id: `ro${i}`, projectId: null, effectiveFrom: '2026-01-01', incrementMinutes: 15, method: 'up', deleted: false, stamp, ...r }),
    ),
    settings: spec.settings ?? {},
    prefs: { theme: 'light', hideEarnings: false, lastCurrency: null, clientZonePromptDone: true },
    notices: [],
    warnings: [],
    sync: { targets: [], detected: [], promptPending: false, pendingCopy: null },
    launch: { warm: true, coldRequired: ['name', 'project', 'description'], copySource: null },
  };
}

export const params = (zone: string, range: RangeSpec, extra: Partial<Params> = {}): Params => ({ zone, range, filters: NO_FILTERS, compare: false, ...extra });

export const nowOf = (iso: string): number => parseIso(iso);
export { toIso };

/** JSON with Maps and typed arrays unrolled and numbers rounded, for deep equality checks. */
export function plain(value: unknown): unknown {
  return JSON.parse(
    JSON.stringify(value, (_k, v: unknown) => {
      if (v instanceof Map) return [...v.entries()].sort((a, b) => String(a[0]).localeCompare(String(b[0])));
      if (v instanceof Float64Array) return [...v];
      if (typeof v === 'number') return Math.round(v * 1e6) / 1e6;
      return v;
    }),
  );
}

/** Every number reachable from `value` that is NaN or infinite. */
export function badNumbers(value: unknown, path = '$', out: string[] = []): string[] {
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) out.push(`${path}=${value}`);
  } else if (value instanceof Map) {
    for (const [k, v] of value) badNumbers(v, `${path}.${String(k)}`, out);
  } else if (Array.isArray(value) || value instanceof Float64Array) {
    Array.from(value as ArrayLike<unknown>).forEach((v, i) => badNumbers(v, `${path}[${i}]`, out));
  } else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) badNumbers(v, `${path}.${k}`, out);
  }
  return out;
}
