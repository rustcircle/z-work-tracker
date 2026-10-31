// Deterministic written insights. Every sentence is built from named metrics and lists their ids,
// which exist in the glossary. No AI, no scores, no advice: plain statements about logged time.
import { centsFromNumerator, money as fmtMoney, MASK, type Numerators } from '../../lib/billing';
import { cityOf } from '../../lib/tz';
import { fmtClock, fmtHM, fmtPct, fmtSignedPct } from './format';
import type { Metrics } from './metrics';
import { dayStr, WEEKDAY_NAMES, MONTH_SHORT } from './range';

export interface Insight {
  id: string;
  /** Glossary ids of the metrics behind the sentence. */
  metrics: string[];
  text: string;
}

const dayText = (n: number): string => {
  const d = dayStr(n);
  return `${Number(d.slice(8))} ${MONTH_SHORT[Number(d.slice(5, 7)) - 1]} ${d.slice(0, 4)}`;
};

export function moneyText(n: Numerators, hide: boolean): string {
  if (hide) return MASK;
  const parts = (['EUR', 'USD'] as const).filter((c) => n[c] !== undefined).map((c) => fmtMoney(c, centsFromNumerator(n[c] as number)));
  return parts.join(' + ');
}

export function buildInsights(m: Metrics, opts: { hideEarnings: boolean; names: ReadonlyMap<string, string> }): Insight[] {
  const out: Insight[] = [];
  const add = (id: string, metrics: string[], text: string): void => void out.push({ id, metrics, text });
  const v = m.volume;
  if (!m.hasData) return out;
  const basisWord = m.basis === 'billable' ? 'billable' : 'exact';

  const prev = v.deltaTotal;
  add('volume', prev ? ['volume.total', 'volume.delta'] : ['volume.total'],
    `You logged ${fmtHM(v.primary)} (${basisWord}) in ${m.period.label}${prev && prev.pct !== null ? `, ${fmtSignedPct(prev.pct)} against the previous period (${fmtHM(prev.prev)})` : ''}.`);

  if (m.time.mostBand !== null) {
    const b = m.time.bands[m.time.mostBand];
    if (b && b.share !== null) add('band', ['time.bands', 'time.mostBand'], `${b.name} is the busiest band: ${fmtPct(b.share)} of logged time (${fmtHM(b.secs)}).`);
  }
  if (m.time.hours.peak !== null) {
    const h = m.time.hours.peak;
    add('hour', ['time.hours'], `Logged time peaks between ${String(h).padStart(2, '0')}:00 and ${String((h + 1) % 24).padStart(2, '0')}:00.`);
  }
  if (m.time.mostWeekday !== null && m.time.leastWeekday !== null && m.time.mostWeekday !== m.time.leastWeekday) {
    const hi = m.time.weekdays[m.time.mostWeekday];
    const lo = m.time.weekdays[m.time.leastWeekday];
    if (hi && lo) add('weekday', ['time.weekdays', 'time.mostWeekday'], `${WEEKDAY_NAMES[hi.index]} has the most logged time (${fmtHM(hi.secs)}) and ${WEEKDAY_NAMES[lo.index]} the least (${fmtHM(lo.secs)}).`);
  }
  const top = m.projects[0];
  if (top && top.share !== null) add('project', ['projects.hours', 'projects.share'], `${top.name} took ${fmtPct(top.share)} of the time (${fmtHM(top.secs)}).`);
  const t = m.tasks;
  if (t.completed > 0) add('tasks', ['tasks.completed'], `${t.completed} ${t.completed === 1 ? 'task was' : 'tasks were'} completed in this period.`);
  if (m.focus.sessions > 0 && m.focus.avg !== null) {
    add('sessions', ['focus.avgSession', 'focus.fragmentation'],
      `Sessions average ${fmtHM(m.focus.avg)}${m.focus.fragmentation !== null ? `; ${fmtPct(m.focus.fragmentation)} of time is in sessions under 25 minutes` : ''}.`);
  }
  if (m.focus.focusRatio !== null && m.focus.pauseCount > 0) {
    add('focus', ['focus.ratio', 'focus.pausedTime'], `Worked time is ${fmtPct(m.focus.focusRatio)} of worked plus paused time, with ${m.focus.pauseCount} pauses.`);
  }
  if (m.consistency.streakCurrent >= 2) add('streak', ['consistency.streak'], `You have logged time on ${m.consistency.streakCurrent} days in a row.`);
  const c = m.consistency;
  if (c.start && c.finish) {
    add('startfinish', ['consistency.start', 'consistency.finish'],
      `Typical start is ${fmtClock(c.start.median)} (middle half ${fmtClock(c.start.q1)} to ${fmtClock(c.start.q3)}) and typical finish ${fmtClock(c.finish.median)}.`);
  }
  const g = m.goals;
  if (g.weekly) add('weekly', ['goals.weekly'], `This week's target is ${fmtHM(g.weekly.target)}; ${fmtHM(g.weekly.secs)} is logged (${fmtPct(g.weekly.attainment)}).`);
  if (g.daily) add('daily', ['goals.daily'], `${g.daily.daysReached} of ${g.daily.daysCounted} elapsed days reached the daily target of ${fmtHM(g.daily.target)}.`);
  for (const b of m.budgets.slice(0, 2)) {
    const name = b.name;
    if (b.state === 'projected' && b.projectedFinish !== null) add(`budget-${b.projectId}`, ['goals.budget'], `${name} has used ${fmtPct(b.fraction)} of its budget; at the pace of the last 28 days it reaches the budget on ${dayText(b.projectedFinish)}.`);
    else if (b.state === 'over') add(`budget-${b.projectId}`, ['goals.budget'], `${name} has logged ${fmtHM(b.loggedSecs)} against a budget of ${fmtHM(b.budgetSecs)}.`);
  }
  if (m.money.available && m.volume.billable !== m.volume.exact) {
    const diff = m.money.roundingSecs;
    add('rounding', ['money.rounding'], `Rounding ${diff >= 0 ? 'added' : 'removed'} ${fmtHM(Math.abs(diff))} ${diff >= 0 ? 'to' : 'from'} Billable time.`);
  }
  if (m.money.available && Object.keys(m.money.numerators).length > 0) {
    add('earnings', ['money.earnings'], `Earnings from Billable time: ${moneyText(m.money.numerators, opts.hideEarnings)}.`);
  }
  const s = m.shifts;
  if (s.configured && s.stats.length > 0 && s.outsideShare !== null) {
    add('shift-outside', ['shifts.outside'], `${fmtPct(s.outsideShare)} of logged time (${fmtHM(s.outside)}) falls outside any shift.`);
    if (s.attainment !== null) add('shift-attain', ['shifts.attainment', 'shifts.scheduled'], `Time inside shifts is ${fmtHM(s.worked)} against ${fmtHM(s.scheduled)} scheduled (${fmtPct(s.attainment)}).`);
  }
  const z = m.zonesView;
  if (z.available && z.overlapShare !== null && z.client) {
    add('zones', ['zones.overlap'], `${fmtPct(z.overlapShare)} of logged time falls inside ${cityOf(z.client)} working hours (${z.workText}).`);
  }
  const f = m.forecast;
  if (f.available && f.projected !== null) add('forecast', ['forecast.projected'], `At the current pace this period reaches about ${fmtHM(f.projected)} (a projection: ${f.basisText}).`);
  return out;
}
