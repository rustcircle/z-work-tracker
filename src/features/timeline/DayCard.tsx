import { memo, useMemo, type ReactNode } from 'react';

import { MASK, money as formatMoney, type RateBook } from '../../lib/billing';
import { BANDS } from '../../lib/split';
import { windowsFor, type ShiftWindow } from '../../lib/shifts';
import { cityOf, dayBounds, dayOf, gapText, humanSpan, parseIso, shiftText, shiftsBetween, zoneLabel } from '../../lib/tz';
import type { Project, RawSegment, ShiftVersion, Task } from '../../lib/types';
import { Axis, KIND_WORD, MARK_WORD } from './Axis';
import { repeatedPass } from './axisGeometry';
import { amountText, clock, clockWithAbbr, dayLabel, formatDuration, formatHMS, hasAmount, relativeDay, shortDay } from '../../components/format';
import { IconEdit, IconWarn } from '../../components/icons';
import { Badge, IconButton, ProjectChip } from '../../components/ui';
import { openAway } from '../away/awayStore';
import { blocksOf, differs, entriesOf, isAway, kindOf, overlapSecs, projectTotals, totalsOf, workWindows, type Block, type DayData, type Entry, type SegKind } from './model';

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
  /** Tasks that continue each task, by the id of the task they continue. */
  chain: ReadonlyMap<string, readonly Task[]>;
  /** Bring a task into view in the rail, and open its editor if asked. */
  onOpenTask: (taskId: string, edit: boolean) => void;
  /** Corrected and hand-entered segments by recorded id. */
  marks: ReadonlyMap<string, RawSegment>;
  /** Voided segments by the day they were recorded on. */
  voided: ReadonlyMap<string, readonly RawSegment[]>;
  /** Notes of billable pauses, by the pause's id. */
  pauseNotes: ReadonlyMap<string, string>;
}

/** "09:00 to 11:20", with the dates where the span leaves `refDay`. Words, for sentences about raw time. */
export function spanWords(start: number, end: number | null, zone: string, refDay: string): string {
  if (end === null) return `${clock(start, zone)} (still running)`;
  const sd = dayOf(start, zone);
  const ed = dayOf(Math.max(start, end - 1), zone);
  const a = clock(start, zone);
  const b = clock(end, zone);
  if (sd === ed) return `${sd !== refDay ? `${shortDay(sd)} ` : ''}${a} to ${b}`;
  return `${shortDay(sd)} ${a} to ${shortDay(ed)} ${b}`;
}

/** A fixed-fee project's fee as text, masked while earnings are hidden; empty if it has none. */
export function feeText(proj: Project | undefined, hide: boolean): string {
  if (!proj || proj.fixedFeeCents === null || proj.feeCurrency === null) return '';
  return hide ? MASK : formatMoney(proj.feeCurrency, proj.fixedFeeCents);
}

const secs = (iso: string | null): number | null => (iso === null ? null : parseIso(iso));

/** Logged time the client's working hours are compared with: not time away, not a billable pause. */
const countsAsWorked = (k: SegKind): boolean => !isAway(k) && k !== 'billablePause';

/** "Recorded 09:00 to 11:20, corrected to 09:00 to 11:05", or for hand-entered time what was typed. */
export function rawNote(raw: RawSegment, zone: string, refDay: string): string {
  const rawStart = parseIso(raw.rawStart);
  const recorded = spanWords(rawStart, secs(raw.rawEnd), zone, refDay);
  const now = spanWords(parseIso(raw.start), secs(raw.end), zone, refDay);
  // The backend keeps the reason typed with a hand-entered segment in the history of changes only.
  const why = raw.reason ? ` Reason: ${raw.reason}` : raw.manual && !raw.corrected ? ' The reason is in the history of changes.' : '';
  if (raw.manual && !raw.corrected) return `Added by hand, ${recorded}.${why}`;
  if (raw.manual) return `Added by hand, ${recorded}, corrected to ${now}.${why}`;
  return `Recorded ${recorded}, corrected to ${now}.${why}`;
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

/** "Continued from X" and "Continued by Y", each a link that moves to that task. */
function ChainLinks({ task, tasks, chain, onOpenTask }: { task: Task | undefined; tasks: ReadonlyMap<string, Task>; chain: ReadonlyMap<string, readonly Task[]>; onOpenTask: (id: string, edit: boolean) => void }) {
  if (!task) return null;
  const from = task.continuedFrom ? tasks.get(task.continuedFrom) : undefined;
  const by = chain.get(task.id) ?? [];
  if (!from && by.length === 0) return null;
  return (
    <ul className="chain chain-entry">
      {from && (
        <li>
          Continued from{' '}
          <button type="button" className="link" onClick={() => onOpenTask(from.id, false)}>
            {from.name}
          </button>
        </li>
      )}
      {by.map((t) => (
        <li key={t.id}>
          Continued by{' '}
          <button type="button" className="link" onClick={() => onOpenTask(t.id, false)}>
            {t.name}
          </button>
        </li>
      ))}
    </ul>
  );
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
    const overlap = client ? overlapSecs(data.pieces.filter((x) => countsAsWorked(kindOf(x.seg))), work) : 0;
    const pendingSecs = entries.filter((e) => e.kind === 'pending').reduce((n, e) => n + e.end - e.start, 0);
    const bands = BANDS.map((name, i) => ({ name, hours: BAND_HOURS[i] as string, entries: entries.filter((e) => e.band === i) })).filter((b) => b.entries.length > 0);
    return { blocks, lanes, windows, entries, totals, perProject, markers, clientMarkers, work, overlap, bands, pendingSecs };
  }, [data, p.shifts, p.book, p.clientWork.start, p.clientWork.end, start, end, zone, client]);

  const zoneFor = (projectId: string): string | null => (client ? (p.projects.get(projectId)?.clientZone ?? client) : null);

  const bothTimes = (s: number, e: number, projectId: string, passes: boolean): string => {
    const own = `${rangeText(s, e, zone, day, passes)} ${cityOf(zone)}`;
    const cz = zoneFor(projectId);
    return cz ? `${own} / ${rangeText(s, e, cz, day, false)} ${cityOf(cz)}` : own;
  };

  const kindPhrase: Record<SegKind, string> = {
    work: '',
    thinking: ', thinking time',
    billablePause: ', billable pause, billed but not worked',
    pending: ', unconfirmed time away, not counted until you confirm',
    dropped: ', dropped time away, not counted',
  };
  const markPhrase = (b: Block): string => {
    const raw = p.marks.get(b.segmentId);
    return raw ? `, ${rawNote(raw, zone, day).toLowerCase().replace(/\.$/, '')}` : '';
  };
  const labelOf = (b: Block): string => `${taskName(b.taskId)}, ${p.projects.get(b.projectId)?.name ?? 'No project'}, ${rangeText(b.start, b.end, zone, day, long)}, ${formatDuration(b.end - b.start)}${kindPhrase[b.kind]}${markPhrase(b)}`;

  const tipOf = (b: Block): ReactNode => {
    const proj = p.projects.get(b.projectId);
    const e = view.entries.filter((x) => x.segId === b.segId);
    const nums = e.reduce<Entry['numerators']>((acc, x) => ({ EUR: (acc.EUR ?? 0) + (x.numerators.EUR ?? 0), USD: (acc.USD ?? 0) + (x.numerators.USD ?? 0) }), {});
    const clean = { ...(nums.EUR ? { EUR: nums.EUR } : {}), ...(nums.USD ? { USD: nums.USD } : {}) };
    const cz = zoneFor(b.projectId);
    const raw = p.marks.get(b.segmentId);
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
          {b.kind === 'work' || b.kind === 'thinking' ? 'Exact duration' : 'Duration'} {formatDuration(b.end - b.start)}
          {b.live ? ' (running)' : ''}
        </span>
        {b.kind === 'thinking' && <span>Thinking time: counts in Exact and Billable.</span>}
        {b.kind === 'billablePause' && <span>Billable pause: counts in Billable, not in Exact.</span>}
        {b.kind === 'pending' && <span>Unconfirmed: not counted until you confirm.</span>}
        {b.kind === 'dropped' && <span>Dropped: not counted.</span>}
        {b.gapKind && <span>{b.gapKind === 'sleep' ? 'The computer was asleep' : 'No activity'}</span>}
        {raw && <span>{rawNote(raw, zone, day)}</span>}
        {isAway(b.kind) ? null : hasAmount(clean) ? (
          <span className="tabular">{b.kind === 'billablePause' ? 'Billable earnings' : 'Exact earnings'} {amountText(clean, p.hide)}</span>
        ) : !proj?.billable ? (
          <span>Non-billable</span>
        ) : proj.billingType === 'fixedFee' ? (
          <span>Fixed fee{feeText(proj, p.hide) && ` ${feeText(proj, p.hide)}`}</span>
        ) : (
          <span>No rate set</span>
        )}
      </>
    );
  };

  const windowTitle = (w: ShiftWindow): string => `${w.name}: ${clock(w.start, w.zone)}–${clock(w.end, w.zone)} ${cityOf(w.zone)}${w.breakSecs ? `, ${humanSpan(w.breakSecs)} break` : ''}, ${formatDuration(w.scheduledSecs)} scheduled`;

  const t = view.totals;
  const money = amountText(t.billable, p.hide);
  const exactMoney = amountText(t.exact, p.hide);
  const split = differs(t);
  const isToday = day === p.today;
  const voidedToday = p.voided.get(day) ?? [];

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
            <dt>{split ? 'Billable' : 'Total'}</dt>
            <dd className="tabular" data-testid="day-billable">
              {formatDuration(t.billableSecs)}
              {money && <span className="day-money"> {money}</span>}
            </dd>
            {t.pauseSecs > 0 && (
              <dd className="day-includes muted" data-testid="day-pause">
                includes {formatDuration(t.pauseSecs)} billable pauses
              </dd>
            )}
            {t.thinkingSecs > 0 && (
              <dd className="day-includes muted" data-testid="day-thinking">
                includes {formatDuration(t.thinkingSecs)} thinking
              </dd>
            )}
          </div>
          {split && (
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
                  {split && <span className="muted"> billable</span>}
                </span>
                {split && (
                  <span className="muted tabular" title={formatHMS(pt.exactSecs)}>
                    {formatDuration(pt.exactSecs)} exact
                  </span>
                )}
                {pt.pauseSecs > 0 && <span className="muted tabular">includes {formatDuration(pt.pauseSecs)} billable pauses</span>}
                {amt ? (
                  <span className="tabular">{amt}</span>
                ) : proj && !proj.billable ? (
                  <span className="muted">Non-billable</span>
                ) : proj?.billingType === 'fixedFee' ? (
                  <span className="fixed-fee" data-testid="fixed-fee">
                    Fixed fee{feeText(proj, p.hide) && <strong className="tabular"> {feeText(proj, p.hide)}</strong>}
                  </span>
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

      {view.pendingSecs > 0 && (
        <p className="day-unconfirmed" data-testid="day-unconfirmed">
          <IconWarn />
          <span>
            <strong>Unconfirmed: not counted until you confirm.</strong> {formatDuration(view.pendingSecs)} of time away on this day is waiting for your answer.
          </span>
          <button type="button" className="link" onClick={openAway}>
            Review time away
          </button>
        </p>
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
          marks={p.marks}
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
        <caption className="visually-hidden">Entries for {dayLabel(day)}, grouped by time of day. Durations and earnings are exact. Time away that is unconfirmed or dropped is listed but counts nowhere.</caption>
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
              const raw = p.marks.get(e.segmentId);
              const away = isAway(e.kind);
              const fixed = proj?.billable && proj.billingType === 'fixedFee';
              return (
                <tr key={e.key} data-testid="entry" data-kind={e.kind}>
                  <td className="tabular">{bothTimes(e.start, e.end, e.projectId, long)}</td>
                  <td>
                    <div className="entry-task">
                      <span>{taskName(e.taskId)}</span>
                      {e.live && <Badge tone="success">Running</Badge>}
                      {e.kind !== 'work' && <Badge tone={e.kind === 'pending' ? 'warning' : e.kind === 'dropped' ? 'danger' : 'accent'}>{KIND_WORD[e.kind]}</Badge>}
                      {raw?.corrected && <Badge tone="neutral">{MARK_WORD.corrected}</Badge>}
                      {raw?.manual && <Badge tone="neutral">{MARK_WORD.manual}</Badge>}
                      {!away && <IconButton label={`Edit task ${taskName(e.taskId)}`} icon={<IconEdit />} className="entry-edit" onClick={() => p.onOpenTask(e.taskId, true)} />}
                    </div>
                    {e.kind === 'thinking' && <p className="entry-note muted">Time away marked as thinking. Counts in Exact and Billable.</p>}
                    {e.kind === 'billablePause' && (
                      <p className="entry-note muted">
                        Billable pause{p.pauseNotes.get(e.segmentId) ? `: ${p.pauseNotes.get(e.segmentId)}` : ''}. Billed, not worked: counts in Billable only.
                      </p>
                    )}
                    {e.kind === 'pending' && (
                      <p className="entry-note">
                        Unconfirmed: not counted until you confirm. {e.gapKind === 'sleep' ? 'The computer was asleep.' : 'No activity.'}{' '}
                        <button type="button" className="link" onClick={openAway}>
                          Decide
                        </button>
                      </p>
                    )}
                    {e.kind === 'dropped' && <p className="entry-note muted">Dropped: removed from your time. {e.gapKind === 'sleep' ? 'The computer was asleep.' : 'No activity.'}</p>}
                    {raw && <p className="entry-note raw-note">{rawNote(raw, zone, day)}</p>}
                    <ChainLinks task={p.tasks.get(e.taskId)} tasks={p.tasks} chain={p.chain} onOpenTask={p.onOpenTask} />
                  </td>
                  <td>{proj ? <ProjectChip name={proj.name} color={proj.color} archived={proj.archived} /> : '—'}</td>
                  <td className={`num tabular ${away ? 'not-counted' : ''}`} title={away ? `${formatHMS(e.end - e.start)}, not counted` : formatHMS(e.end - e.start)}>
                    {formatDuration(e.end - e.start)}
                  </td>
                  <td className="num tabular">
                    {amt || <span className="muted" title={away ? 'Not counted' : fixed ? 'Fixed fee' : proj?.billable ? 'No rate set for this project' : 'Non-billable'}>—</span>}
                  </td>
                </tr>
              );
            })}
          </tbody>
        ))}
      </table>

      {voidedToday.length > 0 && (
        <section className="voided" aria-label="Voided time" data-testid="voided">
          <h4>Voided time</h4>
          <ul className="plain-list">
            {voidedToday.map((r) => (
              <li key={r.id}>
                <strong>{taskName(r.taskId)}</strong>: recorded {spanWords(parseIso(r.rawStart), secs(r.rawEnd), zone, day)}, voided and not counted.{r.reason ? ` Reason: ${r.reason}` : ''}
              </li>
            ))}
          </ul>
        </section>
      )}
    </article>
  );
}

export const DayCard = memo(DayCardImpl);
