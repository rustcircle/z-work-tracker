// Focus and sessions, consistency, goals and money.
import { useState } from 'react';

import { MASK, money as fmtMoney, centsFromNumerator } from '../../lib/billing';
import type { Currency } from '../../lib/types';
import { dayOfInstant } from './engine';
import { BurnUp, Columns, HBars, LineChart, Legend, Progress, StartFinishPlot, countScale, percentScale, timeScale, type Col, type DotColumn, type HRow, type Scale } from './charts';
import { fmtClock, fmtHM, fmtHMS, fmtLong, fmtPct } from './format';
import { moneyText } from './insights';
import { WEEKDAY_NAMES, WEEKDAY_SHORT, dayStr } from './range';
import { projectLegend, segsOf, tipTime, type SecEnv } from './secenv';
import { Card, Invite, Section, Stat, dayText } from './ui';

const EMPTY = 'No time logged in this period. Try another range or clear the filters.';

interface Folded {
  labels: string[];
  worked: number[];
  paused: number[];
  switches: number[];
  days: number[];
}

/** Daily focus figures folded into the chart's buckets. */
function fold(env: SecEnv): Folded {
  const b = env.m.dayBuckets;
  const idx = new Map<number, number>();
  b.forEach((x, i) => {
    for (let n = x.fromDay; n <= x.toDay; n += 1) idx.set(n, i);
  });
  const out: Folded = { labels: b.map((x) => x.label), worked: b.map(() => 0), paused: b.map(() => 0), switches: b.map(() => 0), days: b.map((x) => x.toDay - x.fromDay + 1) };
  for (const d of env.m.focus.daily) {
    const i = idx.get(d.dayNum);
    if (i === undefined) continue;
    out.worked[i] = (out.worked[i] as number) + d.worked;
    out.paused[i] = (out.paused[i] as number) + d.paused;
    out.switches[i] = (out.switches[i] as number) + d.switches;
  }
  return out;
}

export function Focus({ env }: { env: SecEnv }) {
  const { m } = env;
  const f = m.focus;
  const fo = fold(env);
  const distCols: Col[] = f.dist.map((b) => {
    const segs = segsOf(env, b.byProject);
    return { key: b.label, label: b.label, segs, tip: [`Sessions of ${b.label}`, ...segs.map((s) => `${env.pname(s.id)}: ${s.value}`), `Total: ${b.count}`] };
  });
  const wpCols: Col[] = fo.labels.map((label, i) => ({
    key: `${label}-${i}`,
    label,
    segs: [
      { id: 'w', label: 'Worked', value: fo.worked[i] as number, concept: 'worked' as const },
      { id: 'p', label: 'Paused', value: fo.paused[i] as number, concept: 'paused' as const },
    ],
    tip: [label, tipTime('Worked', fo.worked[i] as number), tipTime('Paused', fo.paused[i] as number)],
  }));
  const ratios = fo.labels.map((_, i) => {
    const d = (fo.worked[i] as number) + (fo.paused[i] as number);
    return d > 0 ? (fo.worked[i] as number) / d : null;
  });
  const perDay = fo.labels.map((_, i) => ((fo.switches[i] as number) / (fo.days[i] as number)));
  const maxWP = Math.max(0, ...fo.worked.map((w, i) => w + (fo.paused[i] as number)));
  return (
    <Section id="focus" title="Focus and sessions" lede="Exact time. Logged time measures logged time, not output.">
      <Card title="Sessions" info="focus.sessions" openGlossary={env.openGlossary}>
        <dl className="a-stats">
          <Stat label="Sessions" value={String(f.sessions)} />
          <Stat label="Average session" value={f.avg === null ? 'Not enough data' : fmtHM(f.avg)} info="focus.avgSession" openGlossary={env.openGlossary} />
          <Stat label="Median session" value={f.median === null ? 'Not enough data' : fmtHM(f.median)} />
          <Stat label="Longest session" value={f.longest === null ? 'Not enough data' : fmtHM(f.longest)} />
          <Stat label="Longest uninterrupted stretch" value={f.streak ? fmtHM(f.streak.secs) : 'Not enough data'} info="focus.streak" openGlossary={env.openGlossary} />
          <Stat label="Fragmentation" value={f.fragmentation === null ? 'Not enough data' : fmtPct(f.fragmentation)} sub=" in sessions under 25 min" info="focus.fragmentation" openGlossary={env.openGlossary} />
          <Stat label="Pauses" value={String(f.pauseCount)} sub={f.pauseAvg === null ? '' : ` avg ${fmtLong(f.pauseAvg)}, total ${fmtLong(f.pauseSecs)}`} info="focus.pauses" openGlossary={env.openGlossary} />
          <Stat label="Pauses per task" value={f.pausesPerTask === null ? 'Not enough data' : f.pausesPerTask.toFixed(1)} />
          <Stat label="Focus ratio" value={f.focusRatio === null ? 'Not enough data' : fmtPct(f.focusRatio)} info="focus.ratio" openGlossary={env.openGlossary} />
          <Stat label="Context switches" value={String(f.switchesTotal)} sub={f.switchesPerActiveDay === null ? '' : ` ${f.switchesPerActiveDay.toFixed(1)} per active day`} info="focus.switches" openGlossary={env.openGlossary} />
        </dl>
      </Card>
      <Card
        title="Session length"
        info="focus.dist"
        openGlossary={env.openGlossary}
        data={{ caption: 'Session-length distribution', columns: ['Length', 'Sessions'], rows: f.dist.map((b) => [b.label, b.count]) }}
      >
        <Legend items={projectLegend(env)} />
        <Columns cols={distCols} scale={countScale(Math.max(1, ...f.dist.map((b) => b.count)))} yTitle="sessions" ariaLabel="Number of sessions by length, stacked by project" empty={EMPTY} />
      </Card>
      <Card
        title="Worked vs paused"
        info="focus.pausedTime"
        openGlossary={env.openGlossary}
        wide
        note="A pause counts from the end of one segment of a task to the start of its next, so overnight gaps between sessions of the same task are included; a pause belongs to the day it began."
        data={{ caption: 'Worked and paused time', columns: ['Period', 'Worked', 'Paused'], rows: fo.labels.map((l, i) => [l, fmtHMS(fo.worked[i] as number), fmtHMS(fo.paused[i] as number)]) }}
      >
        <Legend items={[{ key: 'w', label: 'Worked', concept: 'worked' }, { key: 'p', label: 'Paused', concept: 'paused' }]} />
        <Columns cols={wpCols} scale={timeScale(maxWP)} yTitle="hours" ariaLabel="Worked and paused time per period" empty={EMPTY} />
      </Card>
      <Card title="Focus ratio over time" info="focus.ratio" openGlossary={env.openGlossary} data={{ caption: 'Focus ratio', columns: ['Period', 'Focus ratio'], rows: fo.labels.map((l, i) => [l, ratios[i] == null ? '' : fmtPct(ratios[i] as number)]) }}>
        <Legend items={[{ key: 'w', label: 'Worked / (worked + paused)', concept: 'worked' }]} />
        <LineChart xLabels={fo.labels} series={[{ id: 'ratio', concept: 'worked', label: 'Focus ratio', values: ratios }]} scale={percentScale(1)} yTitle="share" ariaLabel="Focus ratio over time" tipFor={(i) => [fo.labels[i] ?? '', ratios[i] == null ? 'Focus ratio: Not enough data' : `Focus ratio: ${fmtPct(ratios[i] as number, 1)}`]} empty={EMPTY} />
      </Card>
      <Card title="Context switches over time" info="focus.switches" openGlossary={env.openGlossary} data={{ caption: 'Context switches per day', columns: ['Period', 'Switches', 'Per day'], rows: fo.labels.map((l, i) => [l, fo.switches[i] as number, (perDay[i] as number).toFixed(2)]) }}>
        <Legend items={[{ key: 'p', label: 'Switches per day', concept: 'paused' }]} />
        <LineChart xLabels={fo.labels} series={[{ id: 'sw', concept: 'paused', label: 'Context switches per day', values: perDay }]} scale={countScale(Math.max(1, ...perDay))} yTitle="per day" ariaLabel="Context switches per day over time" tipFor={(i) => [fo.labels[i] ?? '', `Switches: ${fo.switches[i]} (${(perDay[i] as number).toFixed(2)} per day)`]} empty={EMPTY} />
      </Card>
    </Section>
  );
}

export function Consistency({ env }: { env: SecEnv }) {
  const { m } = env;
  const c = m.consistency;
  const cols: DotColumn[] = c.byWeekday.map((w) => ({
    key: String(w.index),
    label: WEEKDAY_SHORT[w.index] as string,
    starts: w.starts,
    finishes: w.finishes,
    medianStart: w.start?.median ?? (w.starts.length ? w.starts[0] ?? null : null),
    medianFinish: w.finish?.median ?? (w.finishes.length ? w.finishes[0] ?? null : null),
    q1Start: w.start?.q1 ?? null,
    q3Start: w.start?.q3 ?? null,
    q1Finish: w.finish?.q1 ?? null,
    q3Finish: w.finish?.q3 ?? null,
    tip: [
      WEEKDAY_NAMES[w.index] as string,
      w.starts.length === 0 ? 'No days with time' : `${w.starts.length} day${w.starts.length === 1 ? '' : 's'}`,
      ...(w.start ? [`Start: ${fmtClock(w.start.median)} (${fmtClock(w.start.q1)}-${fmtClock(w.start.q3)})`] : w.starts.length ? ['Spread: Not enough data (needs 3 days)'] : []),
      ...(w.finish ? [`Finish: ${fmtClock(w.finish.median)} (${fmtClock(w.finish.q1)}-${fmtClock(w.finish.q3)})`] : []),
    ],
  }));
  const avgCols: Col[] = m.time.weekdays.map((w) => ({
    key: String(w.index),
    label: WEEKDAY_SHORT[w.index] as string,
    segs: [{ id: 'avg', label: 'Average', value: w.avgSecs ?? 0, concept: 'worked' as const }],
    tip: [WEEKDAY_NAMES[w.index] as string, w.avgSecs === null ? 'Average: Not enough data' : tipTime('Average per occurrence', w.avgSecs), `${w.occurrences} occurrence${w.occurrences === 1 ? '' : 's'} so far`],
  }));
  const ot = c.overtime;
  return (
    <Section id="consistency" title="Consistency" lede="When you start and finish, and how even the days are. Exact time.">
      <Card title="Streak and typical day" info="consistency.streak" openGlossary={env.openGlossary}>
        <dl className="a-stats">
          <Stat label="Day streak" value={`${c.streakCurrent} day${c.streakCurrent === 1 ? '' : 's'}`} sub={` longest in period ${c.streakLongest}`} />
          <Stat label="Typical start" value={c.start ? fmtClock(c.start.median) : 'Not enough data'} sub={c.start ? ` middle half ${fmtClock(c.start.q1)}-${fmtClock(c.start.q3)}` : ''} info="consistency.start" openGlossary={env.openGlossary} />
          <Stat label="Typical finish" value={c.finish ? fmtClock(c.finish.median) : 'Not enough data'} sub={c.finish ? ` middle half ${fmtClock(c.finish.q1)}-${fmtClock(c.finish.q3)}` : ''} info="consistency.finish" openGlossary={env.openGlossary} />
          <Stat label="Working span" value={c.spanMedian === null ? 'Not enough data' : fmtHM(c.spanMedian * 60)} sub=" median per day" info="consistency.span" openGlossary={env.openGlossary} />
          <Stat label="Weekday regularity" value={c.regularity === null ? 'Not enough data' : c.regularity.toFixed(2)} sub=" spread of weekday averages, lower is more even" info="consistency.regularity" openGlossary={env.openGlossary} />
          <Stat label="Overtime" value={ot.source === null ? 'Set a daily target or shifts' : fmtHM(ot.secs)} sub={ot.source === null ? '' : ` on ${ot.days} day${ot.days === 1 ? '' : 's'}, against ${ot.source === 'shifts' ? 'shift hours' : 'the daily target'}`} info="consistency.overtime" openGlossary={env.openGlossary} />
        </dl>
      </Card>
      <Card
        title="Typical start and finish by weekday"
        info="consistency.start"
        openGlossary={env.openGlossary}
        note="Bars run from the median start to the median finish; whiskers show the middle half. Circles are individual starts, diamonds individual finishes. Spreads need three days."
        data={{ caption: 'Start and finish by weekday', columns: ['Weekday', 'Days', 'Median start', 'Median finish'], rows: c.byWeekday.map((w) => [WEEKDAY_NAMES[w.index] as string, w.starts.length, w.start ? fmtClock(w.start.median) : '', w.finish ? fmtClock(w.finish.median) : '']) }}
      >
        <StartFinishPlot cols={cols} ariaLabel="Typical start and finish by weekday" fmt={fmtClock} />
      </Card>
      <Card
        title="Weekday averages"
        info="time.weekdays"
        openGlossary={env.openGlossary}
        data={{ caption: 'Average time per weekday occurrence', columns: ['Weekday', 'Average'], rows: m.time.weekdays.map((w) => [WEEKDAY_NAMES[w.index] as string, w.avgSecs === null ? '' : fmtHMS(w.avgSecs)]) }}
      >
        <Legend items={[{ key: 'w', label: 'Worked', concept: 'worked' }]} />
        <Columns cols={avgCols} scale={timeScale(Math.max(0, ...m.time.weekdays.map((w) => w.avgSecs ?? 0)))} yTitle="hours" ariaLabel="Average logged time per weekday" empty={EMPTY} />
      </Card>
    </Section>
  );
}

// ------------------------------------------------------------------ goals and money

function BudgetCard({ env }: { env: SecEnv }) {
  const { m } = env;
  const [pick, setPick] = useState(m.budgets[0]?.projectId ?? '');
  const b = m.budgets.find((x) => x.projectId === pick) ?? m.budgets[0];
  if (!b) return null;
  const today = dayOfInstant(env.nowSec, m.zone);
  const fin =
    b.state === 'projected' && b.projectedFinish !== null
      ? `At the pace of the last 28 days (${fmtHM(b.pace ?? 0)} a day) the budget is reached on ${dayText(dayStr(b.projectedFinish))} (a projection).`
      : b.state === 'over'
        ? `${fmtHM(b.loggedSecs - b.budgetSecs)} over budget.`
        : b.state === 'far'
          ? 'At the current pace the budget would last more than ten years.'
          : 'No time in the last 28 days, so there is no pace to project.';
  return (
    <Card
      title="Budget burn-up"
      info="goals.budget"
      openGlossary={env.openGlossary}
      wide
      note="All-time Exact time on the project; the date range and band, shift and task filters do not apply."
      data={{ caption: 'Budgets', columns: ['Project', 'Logged', 'Budget', 'Used', 'Remaining'], rows: m.budgets.map((x) => [x.name, fmtHMS(x.loggedSecs), fmtHMS(x.budgetSecs), fmtPct(x.fraction, 1), fmtHMS(Math.max(0, x.remainingSecs))]) }}
    >
      <div className="a-row">
        <label className="a-field a-inline">
          <span>Project</span>
          <select value={b.projectId} onChange={(e) => setPick(e.target.value)}>
            {m.budgets.map((x) => (
              <option key={x.projectId} value={x.projectId}>
                {x.name}
              </option>
            ))}
          </select>
        </label>
        <p className="tabular">
          <strong>{fmtHM(b.loggedSecs)}</strong> of {fmtHM(b.budgetSecs)} ({fmtPct(b.fraction)}). {fin}
        </p>
      </div>
      <Legend items={[{ key: 'p', label: b.name, color: b.color }, { key: 'b', label: 'Budget', concept: 'target' }]} />
      <BurnUp color={b.color} series={b.series} budget={b.budgetSecs} finishDay={b.state === 'projected' ? b.projectedFinish : null} today={today} dayLabel={(n) => dayText(dayStr(n))} ariaLabel={`Cumulative hours on ${b.name} against its budget`} />
    </Card>
  );
}

function moneyScale(maxCents: number, sym: string, hide: boolean): Scale {
  const base = countScale(Math.max(1, maxCents / 100));
  return { top: base.top * 100, ticks: base.ticks.map((t) => t * 100), format: (v) => (hide ? '' : `${sym}${Math.round(v / 100)}`) };
}

export function Goals({ env }: { env: SecEnv }) {
  const { m, hide } = env;
  const g = m.goals;
  const mo = m.money;
  const hasMoney = mo.available && (Object.keys(mo.numerators).length > 0 || mo.missingRate.length > 0);
  const cur = (['EUR', 'USD'] as const).filter((c) => mo.numerators[c] !== undefined);
  const flagRows: HRow[] = (['billable', 'non'] as const).map((k) => {
    const ps = m.projects.filter((p) => (k === 'billable') === p.billable && p.billableSecs > 0);
    const segs = ps.map((p) => ({ id: p.id, label: p.name, value: p.billableSecs, fill: p.color }));
    const total = segs.reduce((n, s) => n + s.value, 0);
    return { key: k, label: k === 'billable' ? 'Billable projects' : 'Non-billable', value: total, valueText: fmtHM(total), segs, tip: [k === 'billable' ? 'Billable projects' : 'Non-billable projects', ...segs.map((s) => tipTime(s.label, s.value)), tipTime('Total (Billable time)', total)] };
  });
  const adjRows: HRow[] = m.projects
    .filter((p) => p.adjSecs !== 0)
    .map((p) => ({ key: p.id, label: p.name, value: Math.abs(p.adjSecs), valueText: `${p.adjSecs > 0 ? '+' : '-'}${fmtHM(Math.abs(p.adjSecs))}`, fill: p.color, tip: [p.name, `Billable ${fmtHM(p.billableSecs)} minus Exact ${fmtHM(p.exact)}`, `Adjustment: ${p.adjSecs > 0 ? '+' : '-'}${fmtHM(Math.abs(p.adjSecs))}`] }));
  const weeks = g.weekly?.weeks ?? [];
  const weekCols: Col[] = weeks.map((w) => ({
    key: String(w.start),
    label: dayText(dayStr(w.start)).slice(4),
    segs: [{ id: 'w', label: 'Worked', value: w.secs, concept: 'worked' as const }],
    tip: [`Week of ${dayText(dayStr(w.start))}`, tipTime('Logged (Exact)', w.secs), `${fmtPct(w.attainment)} of the weekly target`],
  }));
  const nothing = !g.configured && m.budgets.length === 0 && !hasMoney;
  return (
    <Section id="goals" title="Goals and money" lede="Optional: targets, budgets, rates and rounding. Each part appears once it is set up.">
      {!m.billableAvailable ? (
        <Invite title="Billable and earnings are hidden">Billing rounds whole task-days, so Billable time, earnings and rounding are hidden while a band or shift filter is on. Clear the filter to see them.</Invite>
      ) : null}
      {nothing ? (
        <Invite title="Set up goals, budgets and rates">
          Add daily and weekly hour targets in Settings, budget hours and a price per hour on a project, and this section fills with attainment, budget burn-up and earnings.{' '}
          <button type="button" className="a-link" onClick={() => env.jumps.openSettings('targets')}>
            Open Settings
          </button>
        </Invite>
      ) : null}
      {g.configured ? (
        <Card title="Targets" info="goals.weekly" openGlossary={env.openGlossary}>
          {g.daily ? (
            <Progress label={`Daily target, ${dayText(dayStr(g.daily.refDay))}`} valueText={fmtHM(g.daily.secs)} targetText={fmtHM(g.daily.target)} fraction={g.daily.attainment} ariaLabel={`Daily target ${fmtPct(g.daily.attainment)} reached`} />
          ) : null}
          {g.daily ? <p className="muted">{g.daily.daysReached} of {g.daily.daysCounted} elapsed days reached the daily target.</p> : null}
          {g.weekly ? (
            <Progress label={`Weekly target, week of ${dayText(dayStr(g.weekly.weekStart))}`} valueText={fmtHM(g.weekly.secs)} targetText={fmtHM(g.weekly.target)} fraction={g.weekly.attainment} ariaLabel={`Weekly target ${fmtPct(g.weekly.attainment)} reached`} />
          ) : null}
        </Card>
      ) : null}
      {g.weekly && weeks.length > 1 ? (
        <Card title="Weekly totals against the target" info="goals.weekly" openGlossary={env.openGlossary} data={{ caption: 'Weekly totals', columns: ['Week of', 'Logged', 'Attainment'], rows: weeks.map((w) => [dayText(dayStr(w.start)), fmtHMS(w.secs), fmtPct(w.attainment, 1)]) }}>
          <Legend items={[{ key: 'w', label: 'Worked', concept: 'worked' }, { key: 't', label: 'Weekly target', concept: 'target' }]} />
          <Columns cols={weekCols} scale={timeScale(Math.max(g.weekly.target, ...weeks.map((w) => w.secs)))} yTitle="hours" ariaLabel="Weekly totals against the weekly target" lines={[{ id: 't', concept: 'target', label: 'Target', values: weeks.map(() => g.weekly?.target ?? null) }]} empty={EMPTY} />
        </Card>
      ) : null}
      {m.budgets.length > 0 ? <BudgetCard env={env} /> : null}
      {mo.available && m.projects.length > 0 ? (
        <Card
          title="Billable vs non-billable"
          info="money.billable"
          openGlossary={env.openGlossary}
          note={mo.billableShare === null ? undefined : `${fmtPct(mo.billableShare)} of Billable time is on billable projects.`}
          data={{ caption: 'Billable and non-billable projects', columns: ['Group', 'Billable time'], rows: flagRows.map((r) => [r.label, fmtHMS(r.value)]) }}
        >
          <HBars rows={flagRows} ariaLabel="Billable time on billable and non-billable projects, split by project" empty={EMPTY} />
        </Card>
      ) : null}
      {hasMoney && cur.length > 0
        ? cur.map((c) => {
            const pts = mo.earnings[c] ?? [];
            const cents = pts.map((p) => p.numerator / 3600);
            const sym = c === 'EUR' ? '€' : '$';
            const cols: Col[] = pts.map((p) => {
              const by = new Map([...p.byProject].map(([id, n]) => [id, n / 3600]));
              const segs = segsOf(env, by);
              return { key: p.key, label: p.label, segs, tip: [p.label, ...[...p.byProject].filter(([, n]) => n > 0).map(([id, n]) => `${env.pname(id)}: ${moneyText({ [c]: n }, hide)}`), `Total: ${moneyText({ [c]: p.numerator }, hide)}`] };
            });
            const hourly = mo.hourlyCents[c];
            return (
              <Card
                key={c}
                title={`Earnings in ${c}`}
                info="money.earnings"
                openGlossary={env.openGlossary}
                wide
                note={`Billable time at the rate in force when it was logged; rounded to cents only in totals.${hourly === undefined ? '' : ` Effective hourly rate ${hide ? MASK : `${fmtMoney(c as Currency, hourly)}`} per Exact hour.`}`}
                data={{ caption: `Earnings in ${c}`, columns: ['Period', 'Earnings'], rows: pts.map((p) => [p.label, hide ? MASK : fmtMoney(c as Currency, centsFromNumerator(p.numerator))]) }}
              >
                <p className="tabular a-money-total">
                  <strong>{moneyText({ [c]: mo.numerators[c] as number }, hide)}</strong> total
                </p>
                <Legend items={projectLegend(env)} />
                <Columns cols={cols} scale={moneyScale(Math.max(0, ...cents), sym, hide)} yTitle={hide ? 'amount (hidden)' : c} ariaLabel={`Earnings in ${c} per period, stacked by project`} empty={EMPTY} />
              </Card>
            );
          })
        : null}
      {mo.available && mo.missingRate.length > 0 ? (
        <Invite title="No rate set">
          {mo.missingRate.map((id) => env.pname(id)).join(', ')} {mo.missingRate.length === 1 ? 'is a billable project' : 'are billable projects'} with logged time and no rate, so they earn nothing here. A rate of zero is different from no rate.{' '}
          {mo.missingRate.map((id) => (
            <button key={id} type="button" className="a-link" onClick={() => env.jumps.openProject(id)}>
              Set a rate for {env.pname(id)}
            </button>
          ))}
        </Invite>
      ) : null}
      {mo.available && m.volume.billable !== m.volume.exact ? (
        <Card title="Rounding adjustment" info="money.rounding" openGlossary={env.openGlossary} data={{ caption: 'Rounding adjustment per project', columns: ['Project', 'Billable minus Exact'], rows: adjRows.map((r) => [r.label, r.valueText]) }}>
          <p className="tabular">
            Billable time is {fmtHM(Math.abs(mo.roundingSecs))} {mo.roundingSecs >= 0 ? 'more' : 'less'} than Exact{Object.keys(mo.roundingMoney).length ? ` (${moneyText(mo.roundingMoney, hide)})` : ''}.
          </p>
          <HBars rows={adjRows} ariaLabel="Rounding adjustment per project" empty="Rounding changed nothing." />
        </Card>
      ) : null}
    </Section>
  );
}

