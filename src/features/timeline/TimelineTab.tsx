import { useCallback, useEffect, useMemo, useState } from 'react';

import { useAppState } from '../../app/store';
import { nextWake, useStepNow, type LiveRow } from '../../app/stepClock';
import { RateBook, numeratorsOf } from '../../lib/billing';
import { addDays, dayBounds, dayOf, zoneLabel } from '../../lib/tz';
import type { Task } from '../../lib/types';
import { amountText, dayLabel, formatDuration, shortDay } from '../../components/format';
import { useNav } from '../../components/nav';
import { Button } from '../../components/ui';
import { isTaskFilterActive, matchingTaskIds } from '../tasks/taskFilter';
import { TaskFilterBar, useTaskFilter } from '../tasks/TaskFilterBar';
import { DayCard } from './DayCard';
import { Legend } from './Legend';
import { SelectionBar } from './SelectionBar';
import { useSelection } from './selection';
import { entryOf } from './selectionLogic';
import { buildClosed, buildOverlay, dayData, differs, filteredDayData, rawIndex, timelineSegs, totalsOf, visibleDays, weekStart, type Totals } from './model';

const PAGE = 14;

function TotalsLine({ label, totals, hide }: { label: string; totals: Totals; hide: boolean }) {
  // Only the Billable amount: it moves in steps. An exact amount would creep up all day.
  const amt = amountText(totals.billable, hide);
  const pauses = totals.pauseSecs > 0 ? ` · includes ${formatDuration(totals.pauseSecs)} billable pauses` : '';
  return (
    <div className="summary-block" data-testid={`summary-${label.toLowerCase().split(' ')[0]}`}>
      <p className="summary-headline">
        <span className="summary-label">{label}:</span> <strong className="tabular">{amt || formatDuration(totals.billableSecs)}</strong>
      </p>
      <p className="muted summary-detail tabular">
        {differs(totals) ? (
          <>
            Billable {formatDuration(totals.billableSecs)}
            {amt && ` (${amt})`} · Exact {formatDuration(totals.exactSecs)}
            {pauses}
          </>
        ) : (
          <>
            {formatDuration(totals.exactSecs)} logged, rounding off{amt && ` (${amt})`}
          </>
        )}
      </p>
    </div>
  );
}

/** The Timeline tab: period totals, then days newest first. Time-based figures move in steps, not by the second. */
export function TimelineTab() {
  const { snapshot, zones } = useAppState();
  const nav = useNav();
  const sel = useSelection();
  const { filter } = useTaskFilter();
  const [count, setCount] = useState(PAGE);
  const hide = snapshot.prefs.hideEarnings;
  const zone = zones.active;
  const client = zones.showBoth ? zones.client : null;

  const book = useMemo(() => new RateBook(snapshot.projects, snapshot.rates), [snapshot.projects, snapshot.rates]);
  const base = useMemo(() => timelineSegs({ segments: snapshot.segments, tasks: snapshot.tasks, gaps: snapshot.gaps }), [snapshot.segments, snapshot.tasks, snapshot.gaps]);
  const raw = useMemo(() => rawIndex(snapshot.rawSegments, zone), [snapshot.rawSegments, zone]);
  const pauseNotes = useMemo(() => new Map(snapshot.pauses.filter((x) => !x.deleted).map((x) => [x.id, x.note])), [snapshot.pauses]);
  const closed = useMemo(() => buildClosed(base, zone, book, snapshot.rounding), [base, zone, book, snapshot.rounding]);

  // The clock for the running stretch is read again only when a step of billable time falls due, when a
  // minute of the running stretch completes, at midnight, or when data changes.
  const nowFor = useCallback((at: number) => buildOverlay(closed, at, book, snapshot.rounding), [closed, book, snapshot.rounding]);
  const now = useStepNow(closed, (at) => {
    const midnight = dayBounds(dayOf(at, zone), zone).end - at;
    // Nothing running: only the end of the day changes what the Timeline says.
    if (closed.liveSegs.length === 0) return midnight;
    const ov = nowFor(at);
    const rows: LiveRow[] = [...ov.rows.values()].flat().map((r) => ({ counted: r.exactSecs + r.pauseSecs, rule: r.rule }));
    return nextWake(rows, at, closed.liveSegs[0]?.start ?? null, midnight);
  });
  const overlay = useMemo(() => nowFor(now), [nowFor, now]);

  const projects = useMemo(() => new Map(snapshot.projects.map((p) => [p.id, p])), [snapshot.projects]);
  const tasks = useMemo(() => new Map(snapshot.tasks.map((t) => [t.id, t])), [snapshot.tasks]);
  const matching = useMemo(() => matchingTaskIds(snapshot.tasks, projects, filter), [snapshot.tasks, projects, filter]);
  const work = useMemo(() => ({ start: snapshot.settings.clientWorkStart ?? '09:00', end: snapshot.settings.clientWorkEnd ?? '17:00' }), [snapshot.settings.clientWorkStart, snapshot.settings.clientWorkEnd]);
  const onSetRate = useCallback((id: string) => nav.openProject(id), [nav]);
  const { goToTask } = nav;
  const onOpenTask = useCallback((id: string, edit: boolean) => goToTask(id, edit), [goToTask]);
  const chain = useMemo(() => {
    const m = new Map<string, Task[]>();
    for (const t of snapshot.tasks) {
      if (!t.continuedFrom) continue;
      const list = m.get(t.continuedFrom);
      if (list) list.push(t);
      else m.set(t.continuedFrom, [t]);
    }
    return m;
  }, [snapshot.tasks]);

  const today = dayOf(now, zone);
  const days = visibleDays(closed, overlay, matching);
  const shown = days.slice(0, count);

  const todayTotals = totalsOf(filteredDayData(closed, overlay, today, matching).rows);
  const monday = weekStart(today);
  const weekRows = Array.from({ length: 7 }, (_, i) => filteredDayData(closed, overlay, addDays(monday, i), matching).rows).flat();
  const weekTotals = totalsOf(weekRows);
  const filtering = isTaskFilterActive(filter);
  const matchingTasks = matching?.size ?? snapshot.tasks.length;

  // The selection: the rows behind each selected task-day, from the unfiltered model so a filter never
  // changes what is selected. Anything whose time has gone (voided, corrected away) leaves the selection.
  const selected = useMemo(() => {
    const rows = [];
    const present = new Set<string>();
    for (const key of sel?.keys ?? []) {
      const { taskId, day } = entryOf(key);
      const row = dayData(closed, overlay, day).rows.find((r) => r.taskId === taskId);
      if (row) {
        rows.push(row);
        present.add(key);
      }
    }
    return { rows, present };
  }, [sel?.keys, closed, overlay]);
  const prune = sel?.prune;
  const missing = sel !== null && selected.present.size !== sel.keys.length;
  useEffect(() => {
    if (missing) prune?.(selected.present);
  }, [missing, prune, selected]);
  const selTotals = useMemo(() => ({ billableSecs: selected.rows.reduce((n, r) => n + r.billableSecs, 0), billable: numeratorsOf(selected.rows) }), [selected.rows]);

  return (
    <div className="page timeline" role="region" aria-label="Timeline">
      <div className="summary" aria-label="Period totals">
        <TotalsLine label="Today" totals={todayTotals} hide={hide} />
        <TotalsLine label="This week" totals={weekTotals} hide={hide} />
        <p className="summary-zone muted">
          {dayLabel(today)}, shown in {zoneLabel(zone, now)}. Weeks start on Monday ({shortDay(monday)}).{filtering && ' Totals and days follow the task filter.'}
        </p>
      </div>
      <TaskFilterBar scope="timeline" matches={matchingTasks} total={snapshot.tasks.length} />
      <Legend />
      {shown.length === 0 && !filtering && <p className="muted empty">Nothing is logged yet. Create a task, press Start, and its time appears here as a block on today's axis.</p>}
      {shown.length === 0 && filtering && <p className="muted empty">No logged time matches this filter. Clear it to see every day again.</p>}
      <div className="days" onKeyDown={sel?.gridKeyDown}>
        {shown.map((d) => (
          <DayCard
            key={d}
            data={filteredDayData(closed, overlay, d, matching)}
            zone={zone}
            client={client}
            clientWork={work}
            myZone={zones.my}
            shifts={snapshot.shifts}
            book={book}
            projects={projects}
            tasks={tasks}
            hide={hide}
            today={today}
            nowSec={d === today ? now : 0}
            onSetRate={onSetRate}
            chain={chain}
            onOpenTask={onOpenTask}
            marks={raw.marks}
            voided={raw.voided}
            pauseNotes={pauseNotes}
          />
        ))}
      </div>
      {days.length > shown.length && (
        <div className="more">
          <Button onClick={() => setCount((c) => c + PAGE)}>Show older ({days.length - shown.length} more days)</Button>
        </div>
      )}
      {sel && (
        <div className="visually-hidden" role="status" aria-live="polite" data-testid="selection-live">
          {sel.live}
        </div>
      )}
      {sel && sel.count > 0 && <SelectionBar count={sel.count} hidden={sel.hidden} totals={selTotals} hide={hide} onExport={nav.openExport} onClear={sel.clear} />}
    </div>
  );
}
