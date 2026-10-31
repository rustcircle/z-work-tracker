// Overview, time of day, projects and tasks.
import { Columns, CalendarHeat, Donut, HBars, HeatLegend, Legend, StackedArea, WeekdayHourHeat, timeScale, type Col, type HRow, type LegendEntry, type Slice } from './charts';
import { fmtHM, fmtHMS, fmtPct, fmtSignedPct } from './format';
import { projectLegend, projectTipLines, segsOf, tipTime, basisWord, type SecEnv } from './secenv';
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
        note={`${m.time.calendar.year}, Exact time per day in the zone shown. Darker is more.`}
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

export function Projects({ env }: { env: SecEnv }) {
  const { m } = env;
  const list = m.projects;
  const total = list.reduce((n, p) => n + p.secs, 0);
  const slices: Slice[] = list
    .filter((p) => p.secs > 0)
    .map((p) => ({
      key: p.id,
      label: p.name,
      value: p.secs,
      color: p.color,
      tip: [p.name, tipTime(basisWord(env), p.secs), `Share: ${p.share === null ? 'n/a' : fmtPct(p.share, 1)}`, `Exact ${fmtHM(p.exact)} · Billable ${fmtHM(p.billableSecs)}`],
      onSelect: () => env.drill({ title: p.name, projectId: p.id }),
    }));
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
    ],
    onSelect: () => env.drill({ title: p.name, projectId: p.id }),
  }));
  const s = m.series;
  const areaSeries = env.order.map((id) => ({ id, color: env.pcolor(id), values: s.points.map((p) => p.byProject.get(id) ?? 0) })).filter((x) => x.values.some((v) => v > 0));
  const areaMax = Math.max(0, ...s.points.map((p) => [...p.byProject.values()].reduce((a, b) => a + b, 0)));
  const noRate = list.filter((p) => p.rate === 'none');
  return (
    <Section id="projects" title="Projects" lede="Project colours are exact; names are always shown in labels, tooltips and tables.">
      <Card
        title="Share of time"
        info="projects.share"
        openGlossary={env.openGlossary}
        data={{ caption: 'Project time', columns: ['Project', basisWord(env), 'Share', 'Exact', 'Billable', 'Tasks', 'Average per task', 'Change vs previous'], rows: list.map((p) => [p.name, fmtHMS(p.secs), p.share === null ? '' : fmtPct(p.share, 1), fmtHMS(p.exact), fmtHMS(p.billableSecs), p.taskCount, p.avgPerTask === null ? '' : fmtHMS(p.avgPerTask), p.delta?.pct == null ? '' : fmtSignedPct(p.delta.pct)]) }}
      >
        <Donut slices={slices} centerTop={fmtHM(total)} centerBottom={basisWord(env)} ariaLabel="Share of time per project" empty={EMPTY} />
      </Card>
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
          <Stat label="Calendar age when completed" value={t.ageMedian === null ? 'Not enough data' : fmtHM(t.ageMedian)} sub={t.ageAvg === null ? '' : ` median; average ${fmtHM(t.ageAvg)}, longest ${fmtHM(t.ageLongest ?? 0)}`} info="tasks.age" openGlossary={env.openGlossary} />
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

