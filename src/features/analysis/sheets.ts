// Analytics sheets for the Excel export. They are built from the same metrics as the screen, for
// the view the Analysis tab last showed (or all logged history when it was never opened), and the
// sheet title names the period and the zone. Durations are seconds, money is exact cents, shares
// are fractions. Sheets holding money are marked containsPrices so client exports can drop them.
import { centsFromNumerator } from '../../lib/billing';
import { dayOf, parseIso, zoneLabel } from '../../lib/tz';
import type { AnalyticsSheet, Snapshot } from '../../lib/types';
import { NO_FILTERS, closedSegs } from './engine';
import { fmtClock } from './format';
import { glossaryEntry } from './glossary';
import { analyze, type Metrics } from './metrics';
import { dayNum, dayStr, MAX_CUSTOM_DAYS, type RangeSpec } from './range';
import { WEEKDAY_NAMES } from './range';
import { publishedAnalysisView, type AnalysisView } from './view';

type Cell = string | number | null;

/** All logged history in the zone, newest 1,830 days at most; the current week when nothing is logged. */
export function historyRange(snapshot: Snapshot, zone: string, nowSec: number): RangeSpec {
  const today = dayOf(nowSec, zone);
  let first = Number.POSITIVE_INFINITY;
  for (const s of closedSegs(snapshot)) first = Math.min(first, s.start);
  for (const s of snapshot.segments) if (s.end === null && s.provisionalEnd === null) first = Math.min(first, parseIso(s.start));
  if (!Number.isFinite(first)) return { kind: 'week', anchor: today };
  const from = dayOf(first, zone);
  const lowest = dayStr(dayNum(today) - MAX_CUSTOM_DAYS + 1);
  const start = from < lowest ? lowest : from;
  return { kind: 'custom', anchor: start, from: start, to: today };
}

const basisOf = (id: string): string => glossaryEntry(id)?.basis ?? '';

export function buildAnalyticsSheets(snapshot: Snapshot, zone: string, nowSec: number, view?: AnalysisView | null): AnalyticsSheet[] {
  const v = view ?? publishedAnalysisView();
  const range = v?.range ?? historyRange(snapshot, zone, nowSec);
  const m = analyze(snapshot, { zone, range, filters: v?.filters ?? NO_FILTERS, compare: v?.compare ?? false }, nowSec, v?.basis ?? 'billable');
  const where = `${m.period.label}, ${zoneLabel(zone, Math.min(nowSec, m.period.to - 1))}`;
  const sheets: AnalyticsSheet[] = [kpiSheet(m, where), bandsSheet(snapshot, m, where), projectsSheet(m, where), weekdaysSheet(m, where)];
  if (m.shifts.configured && m.shifts.stats.length > 0) sheets.push(shiftsSheet(m, where));
  if (m.money.available) sheets.push(earningsPeriodSheet(m, where), earningsProjectSheet(m, where));
  return sheets;
}

function kpiSheet(m: Metrics, where: string): AnalyticsSheet {
  const rows: Cell[][] = [];
  const time = (name: string, secs: number | null, id: string): void => void rows.push([name, secs, null, null, basisOf(id), id]);
  const count = (name: string, n: number | null, id: string): void => void rows.push([name, null, n, null, basisOf(id), id]);
  const share = (name: string, f: number | null, id: string): void => void rows.push([name, null, null, f, basisOf(id), id]);
  const text = (name: string, t: string, id: string): void => void rows.push([`${name}: ${t}`, null, null, null, basisOf(id), id]);
  const vol = m.volume;
  time('Total time (Exact)', vol.exact, 'volume.total');
  time('Total time (Billable)', vol.billable, 'volume.total');
  if (m.billableAvailable) {
    if (vol.billable >= vol.exact) time('Rounding adjustment (Billable minus Exact)', vol.billable - vol.exact, 'money.rounding');
    else rows.push(['Rounding adjustment (Billable minus Exact), negative: see Projects sheet', null, null, null, basisOf('money.rounding'), 'money.rounding']);
  }
  count('Active days', vol.activeDays, 'volume.activeDays');
  count('Calendar days elapsed', vol.elapsedDays, 'volume.avgCalendarDay');
  time('Average per active day', vol.avgPerActiveDay, 'volume.avgActiveDay');
  time('Average per calendar day', vol.avgPerCalendarDay, 'volume.avgCalendarDay');
  time('Average per week', vol.perWeek, 'volume.perWeek');
  const f = m.focus;
  count('Sessions', f.sessions, 'focus.sessions');
  time('Average session', f.avg, 'focus.avgSession');
  time('Median session', f.median, 'focus.avgSession');
  time('Longest session', f.longest, 'focus.avgSession');
  time('Longest uninterrupted stretch', f.streak?.secs ?? null, 'focus.streak');
  count('Pauses', f.pauseCount, 'focus.pauses');
  time('Paused time', f.pauseSecs, 'focus.pausedTime');
  share('Focus ratio', f.focusRatio, 'focus.ratio');
  count('Context switches', f.switchesTotal, 'focus.switches');
  share('Fragmentation (time in sessions under 25 min)', f.fragmentation, 'focus.fragmentation');
  count('Tasks completed', m.tasks.completed, 'tasks.completed');
  count('Tasks in progress', m.tasks.inProgress, 'tasks.inProgress');
  count('Tasks spanning several days', m.tasks.multiDay, 'tasks.multiDay');
  count('Day streak', m.consistency.streakCurrent, 'consistency.streak');
  if (m.consistency.start) text('Typical start', `${fmtClock(m.consistency.start.median)} (middle half ${fmtClock(m.consistency.start.q1)}-${fmtClock(m.consistency.start.q3)})`, 'consistency.start');
  if (m.consistency.finish) text('Typical finish', `${fmtClock(m.consistency.finish.median)} (middle half ${fmtClock(m.consistency.finish.q1)}-${fmtClock(m.consistency.finish.q3)})`, 'consistency.finish');
  if (m.consistency.overtime.source) time(`Overtime against ${m.consistency.overtime.source === 'shifts' ? 'shifts' : 'the daily target'}`, m.consistency.overtime.secs, 'consistency.overtime');
  if (m.goals.daily) share('Daily target attainment (last elapsed day)', m.goals.daily.attainment, 'goals.daily');
  if (m.goals.weekly) share('Weekly target attainment (last elapsed week)', m.goals.weekly.attainment, 'goals.weekly');
  if (m.money.available) share('Share of Billable time on billable projects', m.money.billableShare, 'money.billable');
  if (m.shifts.configured && m.shifts.stats.length > 0) {
    time('Scheduled shift hours', m.shifts.scheduled, 'shifts.scheduled');
    time('Worked inside shifts', m.shifts.worked, 'shifts.attainment');
    time('Outside any shift', m.shifts.outside, 'shifts.outside');
  }
  if (m.zonesView.available) share('Logged time inside client working hours', m.zonesView.overlapShare, 'zones.overlap');
  if (m.forecast.available && m.forecast.projected !== null) time('Projected period total (projection)', m.forecast.projected, 'forecast.projected');
  return {
    name: 'KPI summary',
    title: `Summary: ${where}`,
    columns: [
      { header: 'Metric', kind: 'text' },
      { header: 'Time', kind: 'duration' },
      { header: 'Count', kind: 'int' },
      { header: 'Share', kind: 'percent' },
      { header: 'Time basis', kind: 'text' },
      { header: 'Glossary id', kind: 'text' },
    ],
    rows,
    containsPrices: false,
  };
}

function bandsSheet(snapshot: Snapshot, m: Metrics, where: string): AnalyticsSheet {
  const names = new Map(snapshot.projects.map((p) => [p.id, p.name]));
  const total = m.volume.exact;
  const rows: Cell[][] = [];
  for (const b of m.time.bands) {
    rows.push(['Band', b.name, 'All projects', b.secs, total > 0 ? b.secs / total : null, b.avgPerActiveDay]);
    for (const [p, secs] of [...b.byProject].sort((a, c) => c[1] - a[1])) rows.push(['Band', b.name, names.get(p) ?? p, secs, total > 0 ? secs / total : null, null]);
  }
  m.time.hours.secs.forEach((secs, h) => {
    if (secs > 0) rows.push(['Hour', `${String(h).padStart(2, '0')}:00`, 'All projects', secs, total > 0 ? secs / total : null, m.time.hours.avgPerActiveDay[h] ?? null]);
  });
  return {
    name: 'Bands',
    title: `Time of day (Exact): ${where}`,
    columns: [
      { header: 'Kind', kind: 'text' },
      { header: 'Band or hour', kind: 'text' },
      { header: 'Project', kind: 'text' },
      { header: 'Exact time', kind: 'duration' },
      { header: 'Share', kind: 'percent' },
      { header: 'Average per active day', kind: 'duration' },
    ],
    rows,
    containsPrices: false,
  };
}

function projectsSheet(m: Metrics, where: string): AnalyticsSheet {
  const rows: Cell[][] = m.projects.map((p) => [
    p.name,
    p.exact,
    p.billableSecs,
    p.share,
    p.taskCount,
    p.avgPerTask,
    p.adjSecs / 3600,
    p.prevSecs,
    p.delta?.pct ?? null,
    p.rate === 'none' ? 'No rate set' : p.rate === 'not-billable' ? 'Not billable' : '',
  ]);
  return {
    name: 'Projects',
    title: `Projects (${m.basis === 'billable' ? 'Billable' : 'Exact'} shares): ${where}`,
    columns: [
      { header: 'Project', kind: 'text' },
      { header: 'Exact time', kind: 'duration' },
      { header: 'Billable time', kind: 'duration' },
      { header: 'Share', kind: 'percent' },
      { header: 'Tasks with time', kind: 'int' },
      { header: 'Average per task', kind: 'duration' },
      { header: 'Rounding adjustment (hours)', kind: 'number' },
      { header: 'Previous period', kind: 'duration' },
      { header: 'Change', kind: 'percent' },
      { header: 'Rate', kind: 'text' },
    ],
    rows,
    containsPrices: false,
  };
}

function weekdaysSheet(m: Metrics, where: string): AnalyticsSheet {
  const rows: Cell[][] = m.time.weekdays.map((w) => {
    const c = m.consistency.byWeekday[w.index];
    return [WEEKDAY_NAMES[w.index] as string, w.secs, w.occurrences, w.avgSecs, c?.start ? fmtClock(c.start.median) : null, c?.finish ? fmtClock(c.finish.median) : null];
  });
  return {
    name: 'Weekdays',
    title: `Weekdays (Exact): ${where}`,
    columns: [
      { header: 'Weekday', kind: 'text' },
      { header: 'Exact time', kind: 'duration' },
      { header: 'Occurrences so far', kind: 'int' },
      { header: 'Average per occurrence', kind: 'duration' },
      { header: 'Typical start', kind: 'text' },
      { header: 'Typical finish', kind: 'text' },
    ],
    rows,
    containsPrices: false,
  };
}

function shiftsSheet(m: Metrics, where: string): AnalyticsSheet {
  const rows: Cell[][] = m.shifts.stats.map((s) => [s.name, s.zone, s.windows, s.scheduled, s.worked, s.attainment, s.coverage, s.lateStarts, s.avgLate, s.earlyFinishes, s.avgEarly]);
  rows.push(['Outside any shift', null, null, null, m.shifts.outside, m.shifts.outsideShare, null, null, null, null, null]);
  return {
    name: 'Shifts',
    title: `Shifts (Exact): ${where}`,
    columns: [
      { header: 'Shift', kind: 'text' },
      { header: 'Zone', kind: 'text' },
      { header: 'Windows', kind: 'int' },
      { header: 'Scheduled', kind: 'duration' },
      { header: 'Worked inside', kind: 'duration' },
      { header: 'Attainment (outside row: share of logged time)', kind: 'percent' },
      { header: 'Coverage', kind: 'percent' },
      { header: 'Started after shift start', kind: 'int' },
      { header: 'Average later start', kind: 'duration' },
      { header: 'Finished before shift end', kind: 'int' },
      { header: 'Average earlier finish', kind: 'duration' },
    ],
    rows,
    containsPrices: false,
  };
}

function earningsPeriodSheet(m: Metrics, where: string): AnalyticsSheet {
  const eur = m.money.earnings.EUR;
  const usd = m.money.earnings.USD;
  const billable = new Map<string, number>();
  const exact = new Map<string, number>();
  m.money.flagSeries.forEach((f) => billable.set(f.key, f.billable + f.nonBillable));
  m.series.points.forEach((p) => exact.set(p.key, p.exact));
  const rows: Cell[][] = m.money.buckets.map((b, i) => [
    b.label,
    billable.get(b.key) ?? null,
    m.series.unit === 'hour' ? m.volume.exact : (exact.get(b.key) ?? null),
    eur ? centsFromNumerator((eur[i]?.numerator ?? 0)) : null,
    usd ? centsFromNumerator((usd[i]?.numerator ?? 0)) : null,
  ]);
  rows.push([
    'Total',
    m.volume.billable,
    m.volume.exact,
    m.money.numerators.EUR !== undefined ? centsFromNumerator(m.money.numerators.EUR) : null,
    m.money.numerators.USD !== undefined ? centsFromNumerator(m.money.numerators.USD) : null,
  ]);
  return {
    name: 'Earnings by period',
    title: `Earnings by period (Billable time, rate in force when logged): ${where}`,
    columns: [
      { header: 'Period', kind: 'text' },
      { header: 'Billable time', kind: 'duration' },
      { header: 'Exact time', kind: 'duration' },
      { header: 'Earnings EUR', kind: 'eur' },
      { header: 'Earnings USD', kind: 'usd' },
    ],
    rows,
    containsPrices: true,
  };
}

function earningsProjectSheet(m: Metrics, where: string): AnalyticsSheet {
  const rows: Cell[][] = m.projects.map((p) => {
    const n = m.money.byProject.get(p.id);
    return [
      p.name,
      p.billableSecs,
      n?.EUR !== undefined ? centsFromNumerator(n.EUR) : null,
      n?.USD !== undefined ? centsFromNumerator(n.USD) : null,
      p.rate === 'none' ? 'No rate set' : p.rate === 'not-billable' ? 'Not billable' : '',
    ];
  });
  return {
    name: 'Earnings by project',
    title: `Earnings by project: ${where}`,
    columns: [
      { header: 'Project', kind: 'text' },
      { header: 'Billable time', kind: 'duration' },
      { header: 'Earnings EUR', kind: 'eur' },
      { header: 'Earnings USD', kind: 'usd' },
      { header: 'Rate', kind: 'text' },
    ],
    rows,
    containsPrices: true,
  };
}
