// Shift analytics and the two-zone view.
import { cityOf, dayOf, gapText } from '../../lib/tz';
import { Columns, HBars, Legend, timeScale, type Col, type HRow } from './charts';
import { fmtHM, fmtHMS, fmtPct } from './format';
import { projectLegend, segsOf, tipTime, type SecEnv } from './secenv';
import { Card, Invite, Section, Stat, dayText } from './ui';

const EMPTY = 'No time logged in this period. Try another range or clear the filters.';

export function ShiftsSection({ env }: { env: SecEnv }) {
  const { m } = env;
  const s = m.shifts;
  if (!s.configured || s.stats.length === 0) {
    return (
      <Section id="shifts" title="Shifts">
        <Invite title={s.configured ? 'No shift windows in this period' : 'No shifts set up yet'}>
          {s.configured ? 'Your shifts do not fall on any day of this period.' : 'Add shift windows (for example Morning 09:00-13:00 in your zone, or a coverage shift in the client\'s zone) to compare scheduled and worked hours.'}{' '}
          <button type="button" className="a-link" onClick={() => env.jumps.openSettings('shifts')}>
            Open Settings
          </button>
        </Invite>
      </Section>
    );
  }
  const shiftCols: Col[] = [
    ...s.stats.map((st) => ({
      key: st.shiftId,
      label: st.name,
      segs: [
        { id: 'sched', label: 'Scheduled', value: st.scheduled, concept: 'target' as const },
        { id: 'work', label: 'Worked', value: st.worked, concept: 'worked' as const },
      ],
      tip: [st.name + (st.clientHours ? ' (client-hours shift)' : ''), tipTime('Scheduled', st.scheduled), tipTime('Worked inside', st.worked), st.attainment === null ? 'Attainment: Not enough data' : `Attainment: ${fmtPct(st.attainment, 1)}`],
    })),
    { key: 'outside', label: 'Outside', segs: [{ id: 'out', label: 'Outside any shift', value: s.outside, concept: 'outside' as const }], tip: ['Outside any shift', tipTime('Logged', s.outside)] },
  ];
  const idx = new Map<number, number>();
  m.dayBuckets.forEach((b, i) => {
    for (let n = b.fromDay; n <= b.toDay; n += 1) idx.set(n, i);
  });
  const inS = m.dayBuckets.map(() => 0);
  const outS = m.dayBuckets.map(() => 0);
  for (const d of s.byDay) {
    const i = idx.get(d.dayNum);
    if (i === undefined) continue;
    inS[i] = (inS[i] as number) + d.inShift;
    outS[i] = (outS[i] as number) + d.outside;
  }
  const dayCols: Col[] = m.dayBuckets.map((b, i) => ({
    key: b.key,
    label: b.label,
    segs: [
      { id: 'in', label: 'Inside a shift', value: inS[i] as number, concept: 'worked' as const },
      { id: 'out', label: 'Outside any shift', value: outS[i] as number, concept: 'outside' as const },
    ],
    tip: [b.label, tipTime('Inside a shift', inS[i] as number), tipTime('Outside any shift', outS[i] as number)],
  }));
  const projRows: HRow[] = [
    ...s.stats.map((st) => {
      const segs = segsOf(env, st.byProject);
      return { key: st.shiftId, label: st.name, value: st.worked, valueText: fmtHM(st.worked), segs, tip: [st.name, ...segs.map((x) => tipTime(env.pname(x.id), x.value)), tipTime('Total', st.worked)] };
    }),
    (() => {
      const segs = segsOf(env, s.outsideByProject);
      return { key: 'outside', label: 'Outside any shift', value: s.outside, valueText: fmtHM(s.outside), segs, tip: ['Outside any shift', ...segs.map((x) => tipTime(env.pname(x.id), x.value)), tipTime('Total', s.outside)] };
    })(),
  ];
  const maxDay = Math.max(0, ...inS.map((v, i) => v + (outS[i] as number)));
  return (
    <Section id="shifts" title="Shifts" lede="Neutral figures against your shift windows, Exact time. Each moment is attributed to one window, so nothing is counted twice.">
      <Card title="Scheduled vs worked" info="shifts.attainment" openGlossary={env.openGlossary}>
        <dl className="a-stats">
          <Stat label="Scheduled so far" value={fmtHM(s.scheduled)} info="shifts.scheduled" openGlossary={env.openGlossary} />
          <Stat label="Worked inside shifts" value={fmtHM(s.worked)} sub={s.attainment === null ? '' : ` ${fmtPct(s.attainment)} of scheduled`} />
          <Stat label="Outside any shift" value={fmtHM(s.outside)} sub={s.outsideShare === null ? '' : ` ${fmtPct(s.outsideShare)} of logged time`} info="shifts.outside" openGlossary={env.openGlossary} />
          <Stat label="Overtime against shifts" value={fmtHM(s.overtime.secs)} sub={` on ${s.overtime.days} day${s.overtime.days === 1 ? '' : 's'}`} info="shifts.overtime" openGlossary={env.openGlossary} />
        </dl>
      </Card>
      <Card
        title="Scheduled and worked per shift"
        info="shifts.scheduled"
        openGlossary={env.openGlossary}
        data={{ caption: 'Shift hours', columns: ['Shift', 'Scheduled', 'Worked inside', 'Attainment'], rows: [...s.stats.map((st) => [st.name, fmtHMS(st.scheduled), fmtHMS(st.worked), st.attainment === null ? '' : fmtPct(st.attainment, 1)]), ['Outside any shift', '', fmtHMS(s.outside), '']] }}
      >
        <Legend items={[{ key: 's', label: 'Scheduled', concept: 'target' }, { key: 'w', label: 'Worked inside the shift', concept: 'worked' }, { key: 'o', label: 'Outside any shift', concept: 'outside' }]} />
        <Columns cols={shiftCols} layout="group" scale={timeScale(Math.max(0, ...s.stats.flatMap((x) => [x.scheduled, x.worked]), s.outside))} yTitle="hours" ariaLabel="Scheduled and worked hours per shift" empty={EMPTY} />
      </Card>
      <Card title="Inside and outside shifts" info="shifts.outside" openGlossary={env.openGlossary} wide data={{ caption: 'Inside and outside shifts', columns: ['Period', 'Inside a shift', 'Outside any shift'], rows: m.dayBuckets.map((b, i) => [b.label, fmtHMS(inS[i] as number), fmtHMS(outS[i] as number)]) }}>
        <Legend items={[{ key: 'w', label: 'Inside a shift', concept: 'worked' }, { key: 'o', label: 'Outside any shift', concept: 'outside' }]} />
        <Columns cols={dayCols} scale={timeScale(maxDay)} yTitle="hours" ariaLabel="Time inside and outside shifts per period" markers={[]} empty={EMPTY} />
      </Card>
      <Card title="Shift time by project" info="shifts.byProject" openGlossary={env.openGlossary}>
        <Legend items={projectLegend(env)} />
        <HBars rows={projRows} ariaLabel="Time in each shift by project" empty={EMPTY} />
      </Card>
      <Card title="Start, finish and coverage" info="shifts.late" openGlossary={env.openGlossary}>
        <div className="a-table-wrap">
          <table className="a-table tabular">
            <caption className="visually-hidden">Start and finish against shift bounds</caption>
            <thead>
              <tr>
                <th scope="col">Shift</th>
                <th scope="col">Finished windows</th>
                <th scope="col">Started after shift start</th>
                <th scope="col">Finished before shift end</th>
                <th scope="col">Coverage</th>
              </tr>
            </thead>
            <tbody>
              {s.stats.map((st) => (
                <tr key={st.shiftId}>
                  <th scope="row">
                    {st.name}
                    {st.clientHours ? ' (client hours)' : ''}
                  </th>
                  <td>{st.measured}</td>
                  <td>{st.lateStarts === 0 ? 'none' : `${st.lateStarts}, average ${fmtHM(st.avgLate ?? 0)} later`}</td>
                  <td>{st.earlyFinishes === 0 ? 'none' : `${st.earlyFinishes}, average ${fmtHM(st.avgEarly ?? 0)} earlier`}</td>
                  <td>{st.coverage === null ? 'Not enough data' : fmtPct(st.coverage)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    </Section>
  );
}

export function ZonesSection({ env }: { env: SecEnv }) {
  const { m } = env;
  const z = m.zonesView;
  if (!z.available || !z.client) {
    return (
      <Section id="zones" title="Zones">
        <Invite title="No client zone set">
          Set a client zone to compare your hours with the client&apos;s day.{' '}
          <button type="button" className="a-link" onClick={() => env.jumps.openSettings('zones')}>
            Open Settings
          </button>
        </Invite>
      </Section>
    );
  }
  const bands = ['Night', 'Morning', 'Afternoon', 'Evening'];
  const mk = (arr: number[], who: string): Col[] =>
    arr.map((secs, i) => ({
      key: `${who}${i}`,
      label: bands[i] as string,
      segs: [{ id: who, label: who, value: secs, concept: 'worked' as const }],
      tip: [`${bands[i]} in ${who}`, tipTime('Exact', secs), z.totalSecs > 0 ? `Share: ${fmtPct(secs / z.totalSecs, 1)}` : 'Share: Not enough data'],
    }));
  const top = timeScale(Math.max(0, ...z.bandsMy, ...z.bandsClient));
  const inside = z.overlapSecs;
  const outside = Math.max(0, z.totalSecs - z.overlapSecs);
  const overlapRows: HRow[] = [
    {
      key: 'overlap',
      label: 'Logged time',
      value: z.totalSecs,
      valueText: fmtHM(z.totalSecs),
      segs: [
        { id: 'in', label: 'Inside client working hours', value: inside, concept: 'worked' as const },
        { id: 'out', label: 'Outside client working hours', value: outside, concept: 'outside' as const },
      ],
      tip: ['Logged time', tipTime('Inside client working hours', inside), tipTime('Outside client working hours', outside)],
    },
  ];
  const my = cityOf(z.my);
  const cl = cityOf(z.client);
  return (
    <Section id="zones" title="Zones" lede={`${my} (My zone) and ${cl} (client zone) side by side. Exact time.`}>
      <Card
        title={`Hours by band: ${my} and ${cl}`}
        info="zones.bands"
        openGlossary={env.openGlossary}
        wide
        data={{ caption: 'Hours by band in two zones', columns: ['Band', my, cl], rows: bands.map((b, i) => [b, fmtHMS(z.bandsMy[i] ?? 0), fmtHMS(z.bandsClient[i] ?? 0)]) }}
      >
        <Legend items={[{ key: 'w', label: 'Worked (same scale in both charts)', concept: 'worked' }]} />
        <div className="a-pair">
          <figure>
            <figcaption>{my} (My zone)</figcaption>
            <Columns cols={mk(z.bandsMy, my)} scale={top} yTitle="hours" ariaLabel={`Hours by band in ${my}`} height={200} empty={EMPTY} />
          </figure>
          <figure>
            <figcaption>{cl} (client zone)</figcaption>
            <Columns cols={mk(z.bandsClient, cl)} scale={top} yTitle="hours" ariaLabel={`Hours by band in ${cl}`} height={200} empty={EMPTY} />
          </figure>
        </div>
      </Card>
      <Card title="Overlap with the client's working hours" info="zones.overlap" openGlossary={env.openGlossary} note={`Client working hours: ${z.workText} in ${cl}.`}>
        <p className="tabular a-money-total">
          <strong>{z.overlapShare === null ? 'Not enough data' : fmtPct(z.overlapShare)}</strong> of logged time ({fmtHM(inside)}) falls inside them.
        </p>
        <Legend items={[{ key: 'i', label: 'Inside client working hours', concept: 'worked' }, { key: 'o', label: 'Outside client working hours', concept: 'outside' }]} />
        <HBars rows={overlapRows} ariaLabel="Logged time inside and outside the client's working hours" empty={EMPTY} />
      </Card>
      <Card title="Gap between the zones" info="zones.gap" openGlossary={env.openGlossary}>
        {z.gaps.length > 0 ? (
          <ul className="a-list">
            {z.gaps.map((g) => (
              <li key={g.start}>
                <span className="tabular">
                  {dayText(dayOf(g.start, m.zones.my))} to {dayText(dayOf(g.end - 1, m.zones.my))}
                </span>
                : {gapText(g.start, m.zones.my, z.client as string)}
              </li>
            ))}
          </ul>
        ) : null}
        {z.gaps.length > 1 ? <p className="a-note">The gap changes inside this period because the zones switch daylight saving on different dates.</p> : null}
        <h4 className="a-sub">Clock changes in this period</h4>
        {z.markers.length ? (
          <ul className="a-list">
            {z.markers.map((t) => (
              <li key={t}>{t}</li>
            ))}
          </ul>
        ) : (
          <p className="muted">None in this period.</p>
        )}
      </Card>
    </Section>
  );
}

