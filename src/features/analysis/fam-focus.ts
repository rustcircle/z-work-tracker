// Focus, sessions, pauses and consistency metrics. All use Exact time.
import { dayOfInstant } from './engine';
import type { Ctx } from './mctx';
import { activeDayNums } from './mctx';
import { dayNum, weekdayIndex } from './range';
import { scheduleByDay } from './fam-shifts';
import { mean, median, quantileSorted, ratio, stdPop } from './stats';

export const SESSION_BINS: { label: string; from: number; to: number | null }[] = [
  { label: '<5m', from: 0, to: 300 },
  { label: '5-15m', from: 300, to: 900 },
  { label: '15-25m', from: 900, to: 1500 },
  { label: '25-45m', from: 1500, to: 2700 },
  { label: '45m-1h', from: 2700, to: 3600 },
  { label: '1-2h', from: 3600, to: 7200 },
  { label: '2-4h', from: 7200, to: 14400 },
  { label: '4h+', from: 14400, to: null },
];

/** Sessions shorter than this count as fragmented. */
export const FRAGMENT_SECS = 25 * 60;
/** Two sessions this close (or touching) count as one uninterrupted stretch. */
export const STREAK_GAP_SECS = 1;

export interface FocusDay {
  dayNum: number;
  worked: number;
  paused: number;
  ratio: number | null;
  switches: number;
}

export interface Focus {
  sessions: number;
  avg: number | null;
  median: number | null;
  longest: number | null;
  dist: { label: string; from: number; to: number | null; count: number; byProject: Map<string, number> }[];
  streak: { secs: number; start: number; end: number } | null;
  pauseCount: number;
  pauseSecs: number;
  pauseAvg: number | null;
  pausesPerTask: number | null;
  focusRatio: number | null;
  switchesTotal: number;
  switchesPerActiveDay: number | null;
  fragmentation: number | null;
  daily: FocusDay[];
}

export function focusOf(ctx: Ctx): Focus {
  const { cur } = ctx;
  const spans = cur.spans;
  const lens = cur.lens;
  const total = cur.agg.total;
  const first = dayNum(cur.period.fromDay);
  const daily: FocusDay[] = [];
  for (let i = 0; i < cur.period.days; i += 1) {
    const n = first + i;
    daily.push({ dayNum: n, worked: cur.agg.days.get(n)?.secs ?? 0, paused: 0, ratio: null, switches: 0 });
  }
  const at = (n: number): FocusDay | undefined => daily[n - first];
  const dist = SESSION_BINS.map((b) => ({ ...b, count: 0, byProject: new Map<string, number>() }));
  let frag = 0;
  let streak: { secs: number; start: number; end: number } | null = null;
  let runStart = 0;
  let runEnd = 0;
  let lastDay = Number.NaN;
  let lastTask = '';
  let switches = 0;
  const flush = (): void => {
    if (runEnd > runStart && (!streak || runEnd - runStart > streak.secs)) streak = { secs: runEnd - runStart, start: runStart, end: runEnd };
  };
  spans.forEach((s, i) => {
    const len = s.end - s.start;
    const bin = dist.find((b) => len >= b.from && (b.to === null || len < b.to)) as (typeof dist)[number];
    bin.count += 1;
    bin.byProject.set(s.projectId, (bin.byProject.get(s.projectId) ?? 0) + 1);
    if (len < FRAGMENT_SECS) frag += len;
    if (i === 0 || s.start > runEnd + STREAK_GAP_SECS) {
      flush();
      runStart = s.start;
      runEnd = s.end;
    } else runEnd = Math.max(runEnd, s.end);
    if (s.day === lastDay && s.taskId !== lastTask) {
      switches += 1;
      const d = at(s.day);
      if (d) d.switches += 1;
    }
    lastDay = s.day;
    lastTask = s.taskId;
  });
  flush();
  let pauseSecs = 0;
  const pausedTasks = new Set<string>();
  // Paused time belongs to the day the pause began.
  for (const g of cur.gaps) {
    pauseSecs += g.end - g.start;
    const d = at(dayOfInstant(g.start, ctx.zones.active));
    if (d) d.paused += g.end - g.start;
  }
  for (const s of spans) pausedTasks.add(s.taskId);
  for (const d of daily) d.ratio = ratio(d.worked, d.worked + d.paused);
  const active = activeDayNums(cur).length;
  return {
    sessions: spans.length,
    avg: spans.length ? total / spans.length : null,
    median: quantileSorted(lens, 0.5),
    longest: lens.length ? (lens[lens.length - 1] as number) : null,
    dist,
    streak,
    pauseCount: cur.gaps.length,
    pauseSecs,
    pauseAvg: cur.gaps.length ? pauseSecs / cur.gaps.length : null,
    pausesPerTask: pausedTasks.size ? cur.gaps.length / pausedTasks.size : null,
    focusRatio: ratio(total, total + pauseSecs),
    switchesTotal: switches,
    switchesPerActiveDay: active > 0 ? switches / active : null,
    fragmentation: ratio(frag, total),
    daily,
  };
}

// ------------------------------------------------------------------ consistency

export interface Spread {
  n: number;
  median: number;
  q1: number;
  q3: number;
}

function spreadOf(xs: readonly number[]): Spread | null {
  if (xs.length < 3) return null;
  const s = [...xs].sort((a, b) => a - b);
  return { n: s.length, median: quantileSorted(s, 0.5) as number, q1: quantileSorted(s, 0.25) as number, q3: quantileSorted(s, 0.75) as number };
}

export interface Consistency {
  streakCurrent: number;
  streakLongest: number;
  start: Spread | null;
  finish: Spread | null;
  spanAvg: number | null;
  spanMedian: number | null;
  byWeekday: { index: number; starts: number[]; finishes: number[]; start: Spread | null; finish: Spread | null }[];
  /** Coefficient of variation of the weekday averages; lower is more even. */
  regularity: number | null;
  overtime: { secs: number; days: number; source: 'shifts' | 'daily' | null };
}

export function consistencyOf(ctx: Ctx, weekdayAvgs: readonly (number | null)[]): Consistency {
  const { cur } = ctx;
  const to = dayNum(cur.period.toDay);
  const first = dayNum(cur.period.fromDay);
  const endDay = Math.min(to, ctx.today);
  const worked = (n: number): number => cur.dayTotals.get(n) ?? 0;
  // Current streak: consecutive logged days ending at the period's last elapsed day. A day that
  // has just started with nothing logged yet does not break a streak that ran up to yesterday.
  let n = endDay;
  if (worked(n) <= 0 && n === ctx.today) n -= 1;
  let current = 0;
  while (worked(n - current) > 0 && n - current >= first - 400) current += 1;
  let longest = 0;
  let run = 0;
  for (let d = first; d <= to; d += 1) {
    run = worked(d) > 0 ? run + 1 : 0;
    longest = Math.max(longest, run);
  }
  const starts: number[] = [];
  const finishes: number[] = [];
  const spans: number[] = [];
  const by = Array.from({ length: 7 }, (_, index) => ({ index, starts: [] as number[], finishes: [] as number[] }));
  for (const [d, a] of cur.agg.days) {
    if (a.started === 0 || !Number.isFinite(a.sMin)) continue;
    starts.push(a.sMin);
    finishes.push(a.eMax);
    spans.push(a.eMax - a.sMin);
    const w = by[weekdayIndex(d)] as (typeof by)[number];
    w.starts.push(a.sMin);
    w.finishes.push(a.eMax);
  }
  const avgs = weekdayAvgs.filter((v): v is number => v !== null);
  const mu = mean(avgs);
  const sd = stdPop(avgs);
  // Overtime: shift-scheduled hours when shifts exist, else the daily target. Exact time.
  const sched = scheduleByDay(ctx);
  const daily = ctx.snapshot.settings.dailyTargetHours;
  let overtime = 0;
  let overDays = 0;
  let source: 'shifts' | 'daily' | null = null;
  if (sched.exists) {
    source = 'shifts';
    for (let d = first; d <= Math.min(to, ctx.today); d += 1) {
      const over = worked(d) - (sched.byDay.get(d) ?? 0);
      if (over > 0) {
        overtime += over;
        overDays += 1;
      }
    }
  } else if (daily) {
    source = 'daily';
    for (let d = first; d <= Math.min(to, ctx.today); d += 1) {
      const over = worked(d) - daily * 3600;
      if (over > 0) {
        overtime += over;
        overDays += 1;
      }
    }
  }
  return {
    streakCurrent: current,
    streakLongest: longest,
    start: spreadOf(starts),
    finish: spreadOf(finishes),
    spanAvg: mean(spans),
    spanMedian: median(spans),
    byWeekday: by.map((w) => ({ ...w, start: spreadOf(w.starts), finish: spreadOf(w.finishes) })),
    regularity: avgs.length >= 3 && mu && sd !== null ? sd / mu : null,
    overtime: { secs: overtime, days: overDays, source },
  };
}
