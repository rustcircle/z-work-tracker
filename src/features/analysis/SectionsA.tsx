// Overview, time of day, projects and tasks.
import { useReducer } from 'react';

import { onRadioKeyDown } from '../../components/ui';
import { Columns, CalendarHeat, Donut, EmptyChart, HBars, HeatLegend, Legend, ShareLegend, StackedArea, WeekdayHourHeat, timeScale, type Col, type HRow, type LegendEntry, type ShareLegendItem, type Slice } from './charts';
import { fmtHM, fmtHMS, fmtLong, fmtPct, fmtSignedPct } from './format';
import { projectLegend, projectTipLines, segsOf, tipTime, basisWord, type SecEnv } from './secenv';
import { PiecesCard, feeLine } from './SectionsP2';
import { LEVEL_NOUN, NO_SUBTASK_TIME, SHARE_LEVELS, availabilityOf, defaultLevel, reduceLevel, shownLevel, startLevel, type ShareLevel } from './shareLevels';
import { COMBINATION_NOTE, NO_SUBTASK_LABEL, hoursMinutes, otherNote, otherTip, projectShares, spokenName, subtaskShares, tagShares, taskShares, type ShareModel, type ShareRow } from './shareSlices';
import { ratio } from './stats';
import { Card, Section, Stat, dayText } from './ui';
import { WEEKDAY_NAMES, WEEKDAY_SHORT, dayStr, weekdayIndex } from './range';

const EMPTY = 'No time logged in this period. Try another range or clear the filters.';

function bucketTitle(env: SecEnv, i: number): string {
  const p = env.m.series.points[i];
  if (!p) return '';
  const u = env.m.series.unit;
  if (u === 'hour') return `${p.label}:00-${p.label}:59`;
  if (u === 'day') return dayText(dayStr(p.fromDay));
  if (u === 'week') return `Week of ${dayText(dayStr(p.fromDay))}`;
  return p.label;
}

export function Overview({ env }: { env: SecEnv }) {
  const { m } = env;
  const s = m.series;
  const cols: Col[] = s.points.map((p, i) => {
    const segs = segsOf(env, p.byProject);
    const title = bucketTitle(env, i);
    return {
      key: p.key,
      label: p.label,
      segs,
      tip: [
        title,
        ...projectTipLines(env, segs),
        tipTime(`Total (${s.unit === 'hour' ? 'Exact' : basisWord(env)})`, p.secs),
        ...(p.prev !== null ? [tipTime('Previous period', p.prev)] : []),
        ...(p.target !== null ? [tipTime('Target', p.target)] : []),
      ],
    };
  });
  const hasPrev = s.points.some((p) => p.prev !== null);
  const hasTarget = s.points.some((p) => p.target !== null);
  const legend: LegendEntry[] = [
    ...projectLegend(env),
    ...(hasPrev ? [{ key: 'prev', label: 'Previous period', concept: 'previous' as const }] : []),
    ...(hasTarget ? [{ key: 'target', label: 'Target', concept: 'target' as const }] : []),
  ];
  const f = m.forecast;
  return (
    <Section id="overview" title="Overview" lede={`${m.period.label} in ${env.snapshot.settings.myZone === m.zone ? 'My zone' : 'the zone shown'}; ${s.unit === 'hour' ? 'by hour' : `by ${s.unit}`}.`}>
      <Card
        title="Hours over time"
        info="volume.total"
        openGlossary={env.openGlossary}
        wide
        note={[
          s.note,
          s.markers.length ? `Triangles mark clock changes: ${s.markers.map((k) => k.text).join('; ')}.` : null,
        ]
          .filter(Boolean)
          .join(' ')}
        data={{
          caption: 'Hours over time',
          columns: ['Period', 'Total (chart basis)', 'Exact', 'Billable', ...(hasPrev ? ['Previous period'] : []), ...(hasTarget ? ['Target'] : [])],
          rows: s.points.map((p, i) => [bucketTitle(env, i), fmtHMS(p.secs), fmtHMS(p.exact), fmtHMS(p.billable), ...(hasPrev ? [p.prev === null ? '' : fmtHMS(p.prev)] : []), ...(hasTarget ? [p.target === null ? '' : fmtHMS(p.target)] : [])]),
        }}
      >
        <Legend items={legend} />
        <Columns
          cols={cols}
          scale={timeScale(s.maxSecs)}
          yTitle="hours"
          ariaLabel={`Hours per ${s.unit} for ${m.period.label}, stacked by project`}
          lines={[
            ...(hasPrev ? [{ id: 'prev', concept: 'previous' as const, label: 'Previous period', values: s.points.map((p) => p.prev) }] : []),
            ...(hasTarget ? [{ id: 'target', concept: 'target' as const, label: 'Target', values: s.points.map((p) => p.target) }] : []),
          ]}
          markers={s.markers}
          onSelect={(_c, i) => {
            const p = s.points[i];
            if (!p) return;
            env.drill({ title: bucketTitle(env, i), day: p.fromDay, dayTo: p.toDay, ...(s.unit === 'hour' ? { hour: Number(p.key) } : {}) });
          }}
          empty={EMPTY}
        />
      </Card>
      <PiecesCard env={env} />
      <Card
        title="Projection"
        info="forecast.projected"
        openGlossary={env.openGlossary}
        note={f.available ? 'A projection, not a promise.' : undefined}
      >
        {f.available && f.projected !== null ? (
          <dl className="a-stats">
            <Stat label="Logged so far" value={fmtHM(f.logged)} sub={` (${m.basis === 'billable' ? 'Billable' : 'Exact'})`} />
            <Stat label="Projected at the current pace" value={fmtHM(f.projected)} sub=" projection" />
            {f.target !== null ? <Stat label="Target for the period" value={fmtHM(f.target)} sub={` ${fmtPct(f.projected / f.target)} of target if the pace holds`} /> : null}
            <p className="muted a-basis-text">Basis: {f.basisText}.</p>
          </dl>
        ) : (
          <p className="muted">{f.reason ?? 'Not enough data'}</p>
        )}
      </Card>
      <Card
        title="Year calendar"
        info="time.calendar"
        openGlossary={env.openGlossary}
        wide
        data={{ caption: 'Days with logged time in the calendar year', columns: ['Day', 'Exact time'], rows: m.time.calendar.days.filter((d) => d.secs > 0).map((d) => [d.day, fmtHMS(d.secs)]) }}
        note={`${m.time.calendar.year}, Exact time per day in the zone shown. Shading runs from less to more as in the legend.`}
      >
        <CalendarHeat
          days={m.time.calendar.days}
          max={m.time.calendar.max}
          weekdayOf={weekdayIndex}
          ariaLabel={`Calendar heatmap of ${m.time.calendar.year}`}
          tipFor={(d) => [dayText(d.day), tipTime('Exact', d.secs)]}
          onSelect={(d) => d.secs > 0 && env.drill({ title: dayText(d.day), day: d.dayNum })}
        />
        <HeatLegend label="Calendar shading from less to more time" />
      </Card>
    </Section>
  );
}

export function TimeOfDay({ env }: { env: SecEnv }) {
  const { m } = env;
  const t = m.time;
  const bandCols: Col[] = t.bands.map((b) => {
    const segs = segsOf(env, b.byProject);
    return { key: b.name, label: b.name, segs, tip: [b.name, ...projectTipLines(env, segs), tipTime('Total', b.secs), b.share === null ? 'Share: Not enough data' : `Share: ${fmtPct(b.share, 1)}`, ...(b.avgPerActiveDay !== null ? [tipTime('Average per active day', b.avgPerActiveDay)] : [])] };
  });
  const hourCols: Col[] = t.hours.secs.map((secs, h) => {
    const by = new Map<string, number>();
    for (const [p, arr] of t.hours.byProject) if ((arr[h] ?? 0) > 0) by.set(p, arr[h] as number);
    const segs = segsOf(env, by);
    const avg = t.hours.avgPerActiveDay[h];
    return { key: String(h), label: String(h).padStart(2, '0'), segs, tip: [`${String(h).padStart(2, '0')}:00-${String(h).padStart(2, '0')}:59`, ...projectTipLines(env, segs), tipTime('Total', secs), ...(avg != null ? [tipTime('Average per active day', avg)] : [])] };
  });
  const most = t.mostBand === null ? null : t.bands[t.mostBand];
  const least = t.leastBand === null ? null : t.bands[t.leastBand];
  const mostD = t.mostWeekday === null ? null : t.weekdays[t.mostWeekday];
  const leastD = t.leastWeekday === null ? null : t.weekdays[t.leastWeekday];
  return (
    <Section id="time" title="Time of day" lede="Exact time by wall-clock band and hour in the zone shown.">
      <Card
        title="Hours per band"
        info="time.bands"
        openGlossary={env.openGlossary}
        note={most && least ? `Most active band: ${most.name} (${fmtPct(most.share ?? 0)}). Least: ${least.name} (${fmtPct(least.share ?? 0)}). Band hours can differ on 23 h and 25 h days.` : undefined}
        data={{ caption: 'Hours per band', columns: ['Band', 'Exact time', 'Share', 'Average per active day'], rows: t.bands.map((b) => [b.name, fmtHMS(b.secs), b.share === null ? '' : fmtPct(b.share, 1), b.avgPerActiveDay === null ? '' : fmtHMS(b.avgPerActiveDay)]) }}
      >
        <Legend items={projectLegend(env)} />
        <Columns cols={bandCols} scale={timeScale(Math.max(...t.bands.map((b) => b.secs)))} yTitle="hours" ariaLabel="Hours per band, stacked by project" onSelect={(_c, i) => env.drill({ title: `${t.bands[i]?.name ?? ''} band`, band: i })} empty={EMPTY} />
      </Card>
      <Card
        title="Hour of day"
        info="time.hours"
        openGlossary={env.openGlossary}
        note="Each bar is one wall-clock hour. When clocks go back the repeated hour is one bar holding both passes; the skipped hour stays empty."
        data={{ caption: 'Hour-of-day histogram', columns: ['Hour', 'Exact time', 'Average per active day'], rows: t.hours.secs.map((secs, h) => [`${String(h).padStart(2, '0')}:00`, fmtHMS(secs), t.hours.avgPerActiveDay[h] == null ? '' : fmtHMS(t.hours.avgPerActiveDay[h] as number)]) }}
      >
        <Columns cols={hourCols} scale={timeScale(Math.max(...t.hours.secs))} yTitle="hours" ariaLabel="Hours by hour of day, stacked by project" onSelect={(_c, i) => env.drill({ title: `${String(i).padStart(2, '0')}:00 hour`, hour: i })} empty={EMPTY} />
      </Card>
      <Card
        title="Weekday by hour"
        info="time.heat"
        openGlossary={env.openGlossary}
        wide
        note={mostD && leastD ? `Most active weekday: ${WEEKDAY_NAMES[mostD.index]} (${fmtHM(mostD.secs)}). Least: ${WEEKDAY_NAMES[leastD.index]} (${fmtHM(leastD.secs)}).` : undefined}
        data={{ caption: 'Weekday totals', columns: ['Weekday', 'Exact time', 'Occurrences so far', 'Average per occurrence'], rows: t.weekdays.map((w) => [WEEKDAY_NAMES[w.index] as string, fmtHMS(w.secs), w.occurrences, w.avgSecs === null ? '' : fmtHMS(w.avgSecs)]) }}
      >
        {m.hasData ? (
          <>
            <WeekdayHourHeat
              cells={t.heat.cells}
              max={t.heat.max}
              rowLabels={WEEKDAY_SHORT}
              ariaLabel="Heatmap of logged time by weekday and hour"
              tipFor={(row, h) => [`${WEEKDAY_NAMES[row]} ${String(h).padStart(2, '0')}:00`, tipTime('Exact', t.heat.cells[row * 24 + h] ?? 0)]}
              onSelect={(row, h) => (t.heat.cells[row * 24 + h] ?? 0) > 0 && env.drill({ title: `${WEEKDAY_NAMES[row]} ${String(h).padStart(2, '0')}:00`, weekday: row, hour: h })}
            />
            <HeatLegend label="Heatmap shading from less to more time" />
          </>
        ) : (
          <p className="a-empty">{EMPTY}</p>
        )}
      </Card>
    </Section>
  );
}

function pricingText(env: SecEnv, projectId: string, rate: 'set' | 'none' | 'fixed' | 'not-billable'): string {
  if (rate === 'not-billable') return 'Not billable';
  if (rate === 'none') return 'No rate set';
  if (rate === 'set') return 'Hourly rate';
  const f = env.m.fixedFee.find((x) => x.projectId === projectId);
  return f ? feeLine(env, f) : 'Fixed fee';
}

/** The fixed-fee line of a project's tooltip: its fee and effective hourly rate, never "No rate set". */
function fixedLine(env: SecEnv, projectId: string): string[] {
  const f = env.m.fixedFee.find((x) => x.projectId === projectId);
  return f ? [feeLine(env, f)] : [];
}

/** The time of the basis that is not in use, for a tooltip. Nothing while a band or shift filter has switched Billable off. */
function otherBasisLine(env: SecEnv, exact: number, billable: number): string[] {
  if (!env.m.billableAvailable) return [];
  return [env.m.basis === 'billable' ? `Exact ${fmtHM(exact)}` : `Billable ${fmtHM(billable)}`];
}

/** The model of a level: the rows of the donut and the legend, worked out from the metrics. */
function shareModelOf(level: ShareLevel, env: SecEnv): ShareModel {
  const { m, snapshot } = env;
  switch (level) {
    case 'projects':
      return projectShares(m.projects.map((p) => ({ id: p.id, name: p.name, color: p.color, secs: p.secs })));
    case 'tasks':
      return taskShares(
        m.tasks.list.map((t) => ({ id: t.id, name: t.name, projectId: t.projectId, projectName: env.pname(t.projectId), secs: t.secs })),
        env.pcolor,
      );
    case 'subtasks': {
      const projectOf = new Map(m.tasks.list.map((t) => [t.id, t.projectId]));
      return subtaskShares(
        m.subtasks.map((s) => {
          const projectId = projectOf.get(s.taskId) ?? '';
          return { taskId: s.taskId, taskName: env.tname(s.taskId), projectId, projectName: env.pname(projectId), id: s.id, name: s.name, secs: s.secs };
        }),
        env.pcolor,
      );
    }
    case 'tags':
      // Each task's time by the tags its pieces count under: all of it with the task's tags, unless some subtasks have tags of their own.
      return tagShares(
        m.tags.parts.map((p) => ({ id: p.taskId, secs: p.secs, exact: p.exact, billableSecs: p.billableSecs, tagIds: p.tags })),
        snapshot.tags.filter((t) => !t.deleted).map((t) => ({ id: t.id, name: t.name, color: t.color })),
      );
  }
}

/**
 * The donut of how the time divides, by project, task, subtask or tag, with a legend that writes every slice's hours
 * and percentage as text. Hours are not earnings, so Hide earnings leaves this card as it is.
 *
 * Until the user picks a level, the card shows the one the filter leaves open and moves with the filter (shareLevels.ts).
 * A level chosen by hand stays: no filter change moves it, however often the default moves, and only the user does
 * (reduceLevel). The pick is held in this card's own state, so it lasts as long as the card does and is stored nowhere.
 * Subtasks is switched off while there is no time on a subtask; the card then draws a level that has something to show,
 * and goes back to the pick when its time returns.
 */
function ShareOfTime({ env }: { env: SecEnv }) {
  const { m } = env;
  const basis = basisWord(env);
  const auto = defaultLevel(m.filters);
  const [state, dispatch] = useReducer(reduceLevel, auto, startLevel);
  // The filter moved the default: apply it (or keep the pick) before anything is drawn.
  if (state.auto !== auto) dispatch({ type: 'filters', auto });
  const available = availabilityOf(m.subtasks);
  const level = shownLevel(state.level, auto, available);
  const model = shareModelOf(level, env);
  const projectById = new Map(m.projects.map((p) => [p.id, p]));
  const taskById = new Map(m.tasks.list.map((t) => [t.id, t]));
  const subtaskById = new Map(m.subtasks.map((s) => [`${s.taskId}\u0000${s.id ?? ''}`, s]));
  const lineByKey = new Map(model.lines.map((l) => [l.key, l]));
  /** The tooltip and what a click opens, for one row. */
  const about = (row: ShareRow): { tip: string[]; select: (() => void) | undefined } => {
    const time = [`${basis}: ${row.figure}`, `To the second: ${fmtHMS(row.secs)}`];
    switch (row.kind) {
      case 'project': {
        const p = projectById.get(row.id);
        return {
          tip: [row.label, ...time, ...(p ? otherBasisLine(env, p.exact, p.billableSecs) : [])],
          select: p ? () => env.drill({ title: p.name, projectId: p.id }) : undefined,
        };
      }
      case 'task': {
        const t = taskById.get(row.id);
        return {
          tip: [row.label, `Project: ${env.pname(row.projectId)}`, ...time, ...(t ? otherBasisLine(env, t.exact, t.billableSecs) : [])],
          select: t ? () => env.drill({ title: t.name, taskId: t.id }) : undefined,
        };
      }
      case 'subtask': {
        const s = subtaskById.get(`${row.taskId}\u0000${row.id ?? ''}`);
        return {
          // A row for time on no subtask already has its task in its name.
          tip: [row.label, ...(row.id === null ? [] : [`Task: ${env.tname(row.taskId)}`]), `Project: ${env.pname(row.projectId)}`, ...time, ...(s ? otherBasisLine(env, s.exact, s.billableSecs) : [])],
          select: () => env.drill({ title: row.label, taskId: row.taskId, subtaskId: row.id }),
        };
      }
      case 'tag': {
        const line = lineByKey.get(row.key);
        const n = row.taskIds.length;
        return {
          tip: [row.label, `${n} task${n === 1 ? '' : 's'}`, ...time, ...(line ? otherBasisLine(env, line.exact, line.billableSecs) : [])],
          select: () => env.drill({ title: row.label, tagSet: row.tagIds }),
        };
      }
      case 'other':
        // The grouped rest has no single project, task or tag to open; View data lists every row.
        return { tip: [row.label, ...time, otherTip(row.grouped, row.unit)], select: undefined };
    }
  };
  const described = model.rows.map((row) => ({ row, ...about(row) }));
  const slices: Slice[] = described.map(({ row, tip, select }) => ({
    key: row.key,
    value: row.secs,
    color: row.color,
    ...(row.stripes ? { stripes: row.stripes } : {}),
    tip,
    aria: `${row.title}: ${row.figure}`,
    onSelect: select,
  }));
  // A row names only what the filter leaves open after its own name; the title, the slice and the button carry the whole path.
  const legend: ShareLegendItem[] = described.map(({ row, select }) => ({
    key: row.key,
    label: row.label,
    context: row.context,
    title: row.title,
    ariaLabel: spokenName(row),
    color: row.color,
    ...(row.stripes ? { stripes: row.stripes } : {}),
    hm: row.hm,
    pct: row.pct,
    onSelect: select,
  }));
  const tasksTotal = m.tasks.list.reduce((n, x) => n + x.secs, 0);
  const subtasksTotal = m.subtasks.reduce((n, x) => n + x.secs, 0);
  const share = (secs: number, total: number): string => {
    const r = ratio(secs, total);
    return r === null ? '' : fmtPct(r, 1);
  };
  const data = ((): { caption: string; columns: string[]; rows: (string | number)[][] } => {
    switch (level) {
      case 'projects':
        return {
          caption: 'Project time',
          columns: ['Project', basis, 'Share', 'Exact', 'Billable', 'Tasks', 'Average per task', 'Change vs previous', 'Pricing'],
          rows: m.projects.map((p) => [p.name, fmtHMS(p.secs), p.share === null ? '' : fmtPct(p.share, 1), fmtHMS(p.exact), fmtHMS(p.billableSecs), p.taskCount, p.avgPerTask === null ? '' : fmtHMS(p.avgPerTask), p.delta?.pct == null ? '' : fmtSignedPct(p.delta.pct), pricingText(env, p.id, p.rate)]),
        };
      case 'tasks':
        return {
          caption: 'Task time',
          columns: ['Task', 'Project', basis, 'Share', 'Exact', 'Billable'],
          rows: m.tasks.list.map((x) => [x.name, env.pname(x.projectId), fmtHMS(x.secs), share(x.secs, tasksTotal), fmtHMS(x.exact), fmtHMS(x.billableSecs)]),
        };
      case 'subtasks':
        // The whole path in three columns, and every subtask: the legend groups the smallest into Other.
        return {
          caption: 'Subtask time',
          columns: ['Subtask', 'Task', 'Project', basis, 'Share', 'Exact', 'Billable'],
          rows: [...m.subtasks]
            .filter((x) => x.secs > 0)
            .sort((a, b) => b.secs - a.secs || env.tname(a.taskId).localeCompare(env.tname(b.taskId)))
            .map((x) => [x.id === null ? NO_SUBTASK_LABEL : x.name, env.tname(x.taskId), env.pname(taskById.get(x.taskId)?.projectId ?? ''), fmtHMS(x.secs), share(x.secs, subtasksTotal), fmtHMS(x.exact), fmtHMS(x.billableSecs)]),
        };
      case 'tags':
        return {
          caption: 'Time by tag combination',
          columns: ['Tags', basis, 'Share', 'Exact', 'Billable', 'Tasks'],
          rows: model.lines.map((l) => [l.label, fmtHMS(l.secs), share(l.secs, model.totalSecs), fmtHMS(l.exact), fmtHMS(l.billableSecs), l.taskIds.length]),
        };
    }
  })();
  const other = model.rows.find((r) => r.kind === 'other');
  return (
    <Card title="Share of time" info="projects.share" openGlossary={env.openGlossary} data={data} note={other?.kind === 'other' ? otherNote(other.grouped, other.unit) : undefined}>
      <div className="a-share-switch">
        <div className="a-seg" role="radiogroup" aria-label="Share of time by" onKeyDown={onRadioKeyDown}>
          {SHARE_LEVELS.map((o) => {
            const off = !available[o.level];
            return (
              <button
                key={o.level}
                type="button"
                role="radio"
                aria-checked={level === o.level}
                tabIndex={level === o.level ? 0 : -1}
                disabled={off}
                title={off ? NO_SUBTASK_TIME : undefined}
                className={`a-seg-btn ${level === o.level ? 'is-on' : ''}`}
                onClick={() => dispatch({ type: 'pick', level: o.level })}
              >
                {o.label}
              </button>
            );
          })}
        </div>
      </div>
      {model.rows.length === 0 ? (
        <EmptyChart message={EMPTY} />
      ) : (
        <div className="a-share">
          <div className="a-share-chart">
            <Donut slices={slices} centerTop={hoursMinutes(model.totalMinutes)} centerBottom={basis} ariaLabel={`Share of time per ${LEVEL_NOUN[level]}`} />
          </div>
          <div className="a-share-side">
            <ShareLegend items={legend} ariaLabel={`Share of time legend, ${level}`} />
            {model.combinations > 0 ? <p className="a-share-footnote muted">{COMBINATION_NOTE}</p> : null}
          </div>
        </div>
      )}
    </Card>
  );
}

export function Projects({ env }: { env: SecEnv }) {
  const { m } = env;
  const list = m.projects;
  const rows: HRow[] = list.map((p) => ({
    key: p.id,
    label: p.name,
    value: p.secs,
    valueText: `${fmtHM(p.secs)}${p.share === null ? '' : ` · ${fmtPct(p.share)}`}`,
    fill: p.color,
    mark: p.prevSecs,
    tip: [
      p.name,
      tipTime(basisWord(env), p.secs),
      `Exact ${fmtHM(p.exact)} · Billable ${fmtHM(p.billableSecs)}`,
      `${p.taskCount} task${p.taskCount === 1 ? '' : 's'}${p.avgPerTask === null ? '' : `, ${fmtHM(p.avgPerTask)} average per task`}`,
      ...(p.delta ? [`Previous period: ${fmtHM(p.delta.prev)}${p.delta.pct === null ? '' : ` (${fmtSignedPct(p.delta.pct)})`}`] : []),
      ...(p.rate === 'none' ? ['No rate set'] : []),
      ...fixedLine(env, p.id),
    ],
    onSelect: () => env.drill({ title: p.name, projectId: p.id }),
  }));
  const s = m.series;
  const areaSeries = env.order.map((id) => ({ id, color: env.pcolor(id), values: s.points.map((p) => p.byProject.get(id) ?? 0) })).filter((x) => x.values.some((v) => v > 0));
  const areaMax = Math.max(0, ...s.points.map((p) => [...p.byProject.values()].reduce((a, b) => a + b, 0)));
  const noRate = list.filter((p) => p.rate === 'none');
  return (
    <Section id="projects" title="Projects" lede="Project colours are exact; names are always shown in labels, tooltips and tables.">
      <ShareOfTime env={env} />
      <Card
        title="Ranked projects"
        info="projects.hours"
        openGlossary={env.openGlossary}
        note={m.prevPeriod ? 'The tick marks the previous period.' : undefined}
      >
        <HBars rows={rows} ariaLabel="Projects ranked by time" empty={EMPTY} />
        {noRate.length ? (
          <p className="a-note">
            No rate set for{' '}
            {noRate.map((p, i) => (
              <span key={p.id}>
                {i > 0 ? ', ' : ''}
                {p.name} (
                <button type="button" className="a-link" onClick={() => env.jumps.openProject(p.id)}>
                  set a rate
                </button>
                )
              </span>
            ))}
            .
          </p>
        ) : null}
      </Card>
      <Card
        title="Project trend"
        info="projects.trend"
        openGlossary={env.openGlossary}
        wide
        data={{ caption: 'Project time per period', columns: ['Period', ...env.order.map((id) => env.pname(id))], rows: s.points.map((p) => [p.label, ...env.order.map((id) => fmtHMS(p.byProject.get(id) ?? 0))]) }}
      >
        <Legend items={projectLegend(env, 12)} />
        <StackedArea
          xLabels={s.points.map((p) => p.label)}
          series={areaSeries}
          scale={timeScale(areaMax)}
          yTitle="hours"
          ariaLabel="Stacked area of project time over the period"
          tipFor={(i) => [bucketTitle(env, i), ...env.order.filter((id) => (s.points[i]?.byProject.get(id) ?? 0) > 0).map((id) => tipTime(env.pname(id), s.points[i]?.byProject.get(id) ?? 0))]}
          empty={EMPTY}
        />
      </Card>
    </Section>
  );
}

export function Tasks({ env }: { env: SecEnv }) {
  const { m } = env;
  const t = m.tasks;
  const rows: HRow[] = t.top.map((x) => ({
    key: x.id,
    label: x.name,
    value: x.secs,
    valueText: fmtHM(x.secs),
    fill: env.pcolor(x.projectId),
    tip: [x.name, `Project: ${env.pname(x.projectId)}`, tipTime(basisWord(env), x.secs), `Exact ${fmtHM(x.exact)} · Billable ${fmtHM(x.billableSecs)}`, `${x.days} day${x.days === 1 ? '' : 's'} with time`],
    onSelect: () => env.drill({ title: x.name, taskId: x.id }),
  }));
  return (
    <Section id="tasks" title="Tasks" lede="Completed means stopped in the period; in progress means running or paused with time in it.">
      <Card title="Task counts and durations" info="tasks.duration" openGlossary={env.openGlossary}>
        <dl className="a-stats">
          <Stat label="Completed" value={String(t.completed)} info="tasks.completed" openGlossary={env.openGlossary} />
          <Stat label="In progress" value={String(t.inProgress)} info="tasks.inProgress" openGlossary={env.openGlossary} />
          <Stat label="Tasks with time" value={String(t.withTime)} />
          <Stat label="Average duration" value={t.avg === null ? 'Not enough data' : fmtHM(t.avg)} sub=" Exact" />
          <Stat label="Median duration" value={t.median === null ? 'Not enough data' : fmtHM(t.median)} sub=" Exact" />
          <Stat label="Longest" value={t.longest ? fmtHM(t.longest.exact) : 'Not enough data'} sub={t.longest ? ` ${t.longest.name}` : ''} />
          <Stat label="Calendar age when completed" value={t.ageMedian === null ? 'Not enough data' : fmtLong(t.ageMedian)} sub={t.ageAvg === null ? '' : ` median; average ${fmtLong(t.ageAvg)}, longest ${fmtLong(t.ageLongest ?? 0)}`} info="tasks.age" openGlossary={env.openGlossary} />
          <Stat label="Spanning several days" value={String(t.multiDay)} info="tasks.multiDay" openGlossary={env.openGlossary} />
        </dl>
      </Card>
      <Card
        title="Top tasks"
        info="tasks.top"
        openGlossary={env.openGlossary}
        data={{ caption: 'Tasks by time', columns: ['Task', 'Project', basisWord(env), 'Exact', 'Billable', 'Days with time', 'State'], rows: t.list.map((x) => [x.name, env.pname(x.projectId), fmtHMS(x.secs), fmtHMS(x.exact), fmtHMS(x.billableSecs), x.days, x.state]) }}
      >
        <HBars rows={rows} ariaLabel="Top tasks by time" empty={EMPTY} />
      </Card>
    </Section>
  );
}

