// Pure splitting of raw segments into per-day, per-band pieces for a zone. Durations always come
// from UTC instants, so a 25-hour day can total 25 hours. Bands: Night 00-06, Morning 06-12,
// Afternoon 12-18, Evening 18-24 on the wall clock.
import { addDays, dayOf, instantOfWall, parseIso } from './tz';
import type { Segment, Snapshot, Task } from './types';

export const BANDS = ['Night', 'Morning', 'Afternoon', 'Evening'] as const;
export type BandIndex = 0 | 1 | 2 | 3;

/** A segment with numeric instants. `end` is the effective end for an open segment. */
export interface Seg {
  id: string;
  taskId: string;
  projectId: string;
  deviceId: string;
  start: number;
  end: number;
  /** Open on this device, so it keeps growing with the clock. */
  live: boolean;
  /** Open on another device, counted only up to its last heartbeat. */
  remoteOpen: boolean;
}

export function effectiveEnd(seg: Segment, nowSec: number): number {
  const start = parseIso(seg.start);
  if (seg.end) return Math.max(parseIso(seg.end), start);
  if (seg.provisionalEnd) return Math.max(parseIso(seg.provisionalEnd), start);
  return Math.max(nowSec, start);
}

export function toSegs(snapshot: Pick<Snapshot, 'segments' | 'tasks'>, nowSec: number): Seg[] {
  const projectOf = new Map<string, string>(snapshot.tasks.map((t: Task) => [t.id, t.projectId]));
  const out: Seg[] = [];
  for (const s of snapshot.segments) {
    const projectId = projectOf.get(s.taskId);
    if (projectId === undefined) continue;
    out.push({
      id: s.id,
      taskId: s.taskId,
      projectId,
      deviceId: s.deviceId,
      start: parseIso(s.start),
      end: effectiveEnd(s, nowSec),
      live: s.end === null && s.provisionalEnd === null,
      remoteOpen: s.end === null && s.provisionalEnd !== null,
    });
  }
  return out;
}

export interface Piece {
  seg: Seg;
  day: string;
  band: BandIndex;
  start: number;
  end: number;
}

/** Instants of 00:00, 06:00, 12:00, 18:00 and the next 00:00 for a day, with a per-call cache. */
export class BandClock {
  private cache = new Map<string, number[]>();
  constructor(readonly zone: string) {}

  bounds(day: string): number[] {
    let b = this.cache.get(day);
    if (!b) {
      b = [0, 360, 720, 1080].map((m) => instantOfWall(day, m, this.zone));
      b.push(instantOfWall(addDays(day, 1), 0, this.zone));
      this.cache.set(day, b);
    }
    return b;
  }
}

/** Pieces of `[start, end)`, cut at every band boundary. A zero-length span yields one empty piece. */
export function splitSpan(seg: Seg, start: number, end: number, clock: BandClock): Piece[] {
  const out: Piece[] = [];
  let cur = start;
  for (;;) {
    const day = dayOf(cur, clock.zone);
    const b = clock.bounds(day);
    let band = 0;
    while (band < 3 && cur >= (b[band + 1] as number)) band += 1;
    const cut = b[band + 1] as number;
    const stop = Math.min(end, cut > cur ? cut : end);
    out.push({ seg, day, band: band as BandIndex, start: cur, end: stop });
    if (stop >= end) return out;
    cur = stop;
  }
}

export function splitAll(segs: readonly Seg[], zone: string): Piece[] {
  const clock = new BandClock(zone);
  const out: Piece[] = [];
  for (const s of segs) {
    for (const p of splitSpan(s, s.start, s.end, clock)) out.push(p);
  }
  return out;
}

export const secondsOf = (pieces: readonly Piece[]): number => pieces.reduce((n, p) => n + (p.end - p.start), 0);
