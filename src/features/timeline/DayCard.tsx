import { memo, useMemo, type ReactNode } from 'react';

import type { RateBook } from '../../lib/billing';
import { BANDS } from '../../lib/split';
import { windowsFor, type ShiftWindow } from '../../lib/shifts';
import { cityOf, dayBounds, dayOf, gapText, humanSpan, shiftText, shiftsBetween, zoneLabel } from '../../lib/tz';
import type { Project, ShiftVersion, Task } from '../../lib/types';
import { Axis } from './Axis';
import { repeatedPass } from './axisGeometry';
import { amountText, clock, clockWithAbbr, dayLabel, formatDuration, formatHMS, hasAmount, relativeDay, shortDay } from '../../components/format';
import { Badge, ProjectChip } from '../../components/ui';
import { blocksOf, entriesOf, overlapSecs, projectTotals, totalsOf, workWindows, type Block, type DayData, type Entry } from './model';

const BAND_HOURS = ['00–06', '06–12', '12–18', '18–24'] as const;

export interface DayCardProps {
  data: DayData;
  zone: string;
  /** The global client zone when "Show both" is on, else null. */
  client: string | null;
  clientWork: { start: string; end: string };
  myZone: string;
  shifts: readonly ShiftVersion[];
  book: RateBook;
  projects: ReadonlyMap<string, Project>;
  tasks: ReadonlyMap<string, Task>;
  hide: boolean;
  today: string;
  /** Current time, passed only to today's card so older cards never re-render on a tick. */
  nowSec: number;
  onSetRate: (projectId: string) => void;
}

/** "14:00–16:30", with a date prefix where the zone's date differs from the card's date. */
export function rangeText(start: number, end: number, zone: string, refDay: string, passes = false): string {
  const sd = dayOf(start, zone);
  const ed = dayOf(Math.max(start, end - 1), zone);
  const endsAtMidnight = dayOf(end, zone) !== ed;
  const a = clock(start, zone);
  const b = endsAtMidnight && ed === sd && sd === refDay ? '24:00' : clock(end, zone);
  const pass = passes ? repeatedPass(start, zone) : null;
  const suffix = pass ? ` (${pass === 1 ? '1st' : '2nd'} pass)` : '';
  if (sd === ed) return `${sd !== refDay ? `${shortDay(sd)} ` : ''}${a}–${b}${suffix}`;
  return `${shortDay(sd)} ${a} – ${shortDay(ed)} ${b}${suffix}`;
}

function DayCardImpl(p: DayCardProps) {
  const { data, zone, client } = p;
  const day = data.day;
  const bounds = useMemo(() => dayBounds(day, zone), [day, zone]);
  const { start, end } = bounds;
  const mid = start + bounds.length / 2;
  const long = bounds.length > 86400;
  const taskName = (id: string): string => p.tasks.get(id)?.name ?? 'Unknown task';

  const view = useMemo(() => {
    const { blocks, lanes } = blocksOf(data.pieces);
    const windows: ShiftWindow[] = windowsFor(p.shifts, start, end);
    const entries = entriesOf(data.pieces, p.book);
    const totals = totalsOf(data.rows);
    const perProject = projectTotals(data.rows);
    const markers = shiftsBetween(start, end, zone);
    const clientMarkers = client ? shiftsBetween(start, end, client) : [];
    const work = client ? workWindows(start, end, client, p.clientWork.start, p.clientWork.end) : [];
    const overlap = client ? overlapSecs(data.pieces, work) : 0;
    const bands = BANDS.map((name, i) => ({ name, hours: BAND_HOURS[i] as string, entries: entries.filter((e) => e.band === i) })).filter((b) => b.entries.length > 0);
    return { blocks, lanes, windows, entries, totals, perProject, markers, clientMarkers, work, overlap, bands };
  }, [data, p.shifts, p.book, p.clientWork.start, p.clientWork.end, start, end, zone, client]);

  const zoneFor = (projectId: string): string | null => (client ? (p.projects.get(projectId)?.clientZone ?? client) : null);

  const bothTimes = (s: number, e: number, projectId: string, passes: boolean): string => {
    const own = `${rangeText(s, e, zone, day, passes)} ${cityOf(zone)}`;
    const cz = zoneFor(projectId);
    return cz ? `${own} / ${rangeText(s, e, cz, day, false)} ${cityOf(cz)}` : own;
  };

  const labelOf = (b: Block): string => `${taskName(b.taskId)}, ${p.projects.get(b.projectId)?.name ?? 'No project'}, ${rangeText(b.start, b.end, zone, day, long)}, ${formatDuration(b.end - b.start)}`;

  const tipOf = (b: Block): ReactNode => {
    const proj = p.projects.get(b.projectId);
    const e = view.entries.filter((x) => x.segId === b.segId);
    const nums = e.reduce<Entry['numerators']>((acc, x) => ({ EUR: (acc.EUR ?? 0) + (x.numerators.EUR ?? 0), USD: (acc.USD ?? 0) + (x.numerators.USD ?? 0) }), {});
    const clean = { ...(nums.EUR ? { EUR: nums.EUR } : {}), ...(nums.USD ? { USD: nums.USD } : {}) };
    const cz = zoneFor(b.projectId);
    return (
      <>
        <strong>{taskName(b.taskId)}</strong>
        <span>{proj?.name ?? 'No project'}</span>
        <span className="tabular">
          {clockWithAbbr(b.start, zone)} to {clockWithAbbr(b.end, zone)}
        </span>
        {cz && (
          <span className="tabular">
            {clockWithAbbr(b.start, cz)} to {clockWithAbbr(b.end, cz)}
          </span>
        )}
        <span className="tabular" title={formatHMS(b.end - b.start)}>
          Exact duration {formatDuration(b.end - b.start)}
          {b.live ? ' (running)' : ''}
        </span>
        {hasAmount(clean) ? <span className="tabular">Exact earnings {amountText(clean, p.hide)}</span> : proj?.billable ? <span>No rate set</span> : <span>Non-billable</span>}
      </>
    );
  };

  const windowTitle = (w: ShiftWindow): string => `${w.name}: ${clock(w.start, w.zone)}–${clock(w.end, w.zone)} ${cityOf(w.zone)}${w.breakSecs ? `, ${humanSpan(w.breakSecs)} break` : ''}, ${formatDuration(w.scheduledSecs)} scheduled`;

  const t = view.totals;
  const money = amountText(t.billable, p.hide);
  const exactMoney = amountText(t.exact, p.hide);
  const isToday = day === p.today;

  return (
    <article className="day" aria-label={dayLabel(day)} data-day={day}>
      <header className="day-head">
        <div className="day-title">
          <h3>{relativeDay(day, p.today)}</h3>
          <span className="muted day-zone" title="The zone this day is cut in">
            {zoneLabel(zone, mid)}
          </span>
          {bounds.length !== 86400 && <Badge tone="warning" title="Clocks changed on this day, so it is not 24 hours long">{bounds.length / 3600}-hour day</Badge>}
        </div>
        <dl className="day-totals">
          <div className="day-total-primary">
            <dt>{t.rounded ? 'Billable' : 'Total'}</dt>
            <dd className="tabular" data-testid="day-billable">
              {formatDuration(t.billableSecs)}
              {money && <span className="day-money"> {money}</span>}
            </dd>
          </div>
          {t.rounded && (
            <div>
              <dt>Exact</dt>
              <dd className="tabular" title={formatHMS(t.exactSecs)} data-testid="day-exact">
                {formatDuration(t.exactSecs)}
                {exactMoney && <span className="day-money"> {exactMoney}</span>}
              </dd>
            </div>
          )}
        </dl>
      </header>

      {view.perProject.length > 0 && (
        <ul className="proj-totals" aria-label="Totals per project">
          {view.perProject.map((pt) => {
            const proj = p.projects.get(pt.projectId);
            const amt = amountText(pt.billable, p.hide);
            return (
              <li key={pt.projectId}>
                {proj ? <ProjectChip name={proj.name} color={proj.color} archived={proj.archived} /> : <Badge>Unknown project</Badge>}
                <span className="tabular">
                  {formatDuration(pt.billableSecs)}
                  {t.rounded && <span className="muted"> billable</span>}
                </span>
                {t.rounded && (
                  <span className="muted tabular" title={formatHMS(pt.exactSecs)}>
                    {formatDuration(pt.exactSecs)} exact
                  </span>
                )}
                {amt ? (
                  <span className="tabular">{amt}</span>
                ) : proj && !proj.billable ? (
                  <span className="muted">Non-billable</span>
                ) : (
                  <span className="no-rate">
                    No rate set{' '}
                    <button type="button" className="link" onClick={() => p.onSetRate(pt.projectId)}>
                      Set rate
                    </button>
                  </span>
                )}
              </li>
            );
          })}
        </ul>
      )}

      <div className="axes">
        <Axis
          start={start}
          end={end}
          zone={zone}
          name={`${cityOf(zone)} time`}
          blocks={view.blocks}
          lanes={view.lanes}
          windows={view.windows}
          markers={view.markers}
          nowSec={isToday ? p.nowSec : undefined}
          projects={p.projects}
          interactive
          labelOf={labelOf}
          tipOf={tipOf}
          windowTitle={windowTitle}
          refDay={day}
        />
        {client && (
          <>
            <p className="axis-caption">
              <strong>{cityOf(client)} time</strong> on the same instants, with the client's working hours {p.clientWork.start}–{p.clientWork.end} shaded.
            </p>
            <Axis
              start={start}
              end={end}
              zone={client}
              name={`${cityOf(client)} time`}
              blocks={view.blocks}
              lanes={view.lanes}
              windows={view.windows}
              markers={view.clientMarkers}
              work={view.work}
              workLabel={`Client working hours ${p.clientWork.start}–${p.clientWork.end}`}
              projects={p.projects}
              interactive={false}
              refDay={day}
            />
            <p className="both-note" data-testid="both-note">
              {gapText(mid, p.myZone, client)}.{' '}
              {view.overlap > 0 ? (
                <span data-testid="overlap">
                  <strong>{formatDuration(view.overlap)}</strong> of this day's logged time falls inside the client's working hours.
                </span>
              ) : (
                <span data-testid="overlap">No logged time falls inside the client's working hours.</span>
              )}
            </p>
          </>
        )}
        {(view.markers.length > 0 || view.clientMarkers.length > 0) && (
          <ul className="zone-changes" aria-label="Clock changes on this day">
            {[...view.markers, ...view.clientMarkers].map((m) => (
              <li key={`${m.zone}${m.at}`}>
                <span aria-hidden="true">◆ </span>
                {shiftText(m)} at {clock(m.at, zone)} {cityOf(zone)} time.
              </li>
            ))}
          </ul>
        )}
        {view.windows.length > 0 && (
          <p className="band-legend muted">
            Shaded bands are shifts: {[...new Set(view.windows.map((w) => `${w.name} ${clock(w.start, w.zone)}–${clock(w.end, w.zone)} ${cityOf(w.zone)}`))].join(', ')}.
          </p>
        )}
      </div>

      <table className="entries">
        <caption className="visually-hidden">Entries for {dayLabel(day)}, grouped by time of day. Durations and earnings are exact.</caption>
        <thead>
          <tr>
            <th scope="col">Time{client ? ` (${cityOf(zone)} / ${cityOf(client)})` : ''}</th>
            <th scope="col">Task</th>
            <th scope="col">Project</th>
            <th scope="col" className="num">Duration</th>
            <th scope="col" className="num">Earnings</th>
          </tr>
        </thead>
        {view.bands.map((b) => (
          <tbody key={b.name} aria-label={`${b.name} ${b.hours}`}>
            <tr className="band-row">
              <th scope="rowgroup" colSpan={5}>
                {b.name} <span className="muted">{b.hours}</span>
              </th>
            </tr>
            {b.entries.map((e) => {
              const proj = p.projects.get(e.projectId);
              const amt = amountText(e.numerators, p.hide);
              return (
                <tr key={e.key} data-testid="entry">
                  <td className="tabular">{bothTimes(e.start, e.end, e.projectId, long)}</td>
                  <td>
                    {taskName(e.taskId)}
                    {e.live && <Badge tone="success">Running</Badge>}
                  </td>
                  <td>{proj ? <ProjectChip name={proj.name} color={proj.color} archived={proj.archived} /> : '—'}</td>
                  <td className="num tabular" title={formatHMS(e.end - e.start)}>
                    {formatDuration(e.end - e.start)}
                  </td>
                  <td className="num tabular">{amt || <span className="muted" title={proj?.billable ? 'No rate set for this project' : 'Non-billable'}>—</span>}</td>
                </tr>
              );
            })}
          </tbody>
        ))}
      </table>
    </article>
  );
}

export const DayCard = memo(DayCardImpl);
