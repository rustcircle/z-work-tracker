// What every section needs to turn metrics into charts.
import type { Snapshot } from '../../lib/types';
import type { LegendEntry, Seg } from './charts';
import type { DrillSel } from './drill';
import { fmtHM, fmtHMS } from './format';
import type { Metrics } from './metrics';
import type { Jumps } from './nav';

export interface SecEnv {
  m: Metrics;
  snapshot: Snapshot;
  hide: boolean;
  nowSec: number;
  pname: (id: string) => string;
  pcolor: (id: string) => string;
  tname: (id: string) => string;
  /** Project ids in stacking order: largest first. */
  order: readonly string[];
  drill: (sel: DrillSel) => void;
  openGlossary: (id: string) => void;
  jumps: Jumps;
}

/** Stack segments of one bar, in the same project order in every chart. */
export function segsOf(env: SecEnv, by: ReadonlyMap<string, number>): Seg[] {
  const out: Seg[] = [];
  for (const id of env.order) {
    const v = by.get(id) ?? 0;
    if (v > 0) out.push({ id, label: env.pname(id), value: v, fill: env.pcolor(id) });
  }
  return out;
}

export function projectLegend(env: SecEnv, limit = 10): LegendEntry[] {
  return env.order.slice(0, limit).map((id) => ({ key: id, label: env.pname(id), color: env.pcolor(id) }));
}

export const tipTime = (label: string, secs: number): string => `${label}: ${fmtHM(secs)} (${fmtHMS(secs)})`;

export function projectTipLines(env: SecEnv, segs: readonly Seg[]): string[] {
  return segs.map((s) => tipTime(env.pname(s.id), s.value));
}

export const basisWord = (env: SecEnv): string => (env.m.basis === 'billable' ? 'Billable' : 'Exact');
