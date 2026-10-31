import { useCallback, useMemo, useState } from 'react';

import { useApp } from '../../app/store';
import { RateBook, centsFromNumerator, type Numerators } from '../../lib/billing';
import { addDays, dayOf, zoneLabel } from '../../lib/tz';
import type { Task } from '../../lib/types';
import { amountText, addNumerators, dayLabel, formatDuration, hasAmount, shortDay } from '../../components/format';
import { MASK, money } from '../../lib/billing';
import { useNav } from '../../components/nav';
import { Button } from '../../components/ui';
import { DayCard } from './DayCard';
import { Legend } from './Legend';
import { allDays, buildClosed, buildOverlay, dayData, differs, rawIndex, timelineSegs, totalsOf, weekStart, type Totals } from './model';

const PAGE = 14;

function TotalsLine({ label, totals, hide, running }: { label: string; totals: Totals; hide: boolean; running?: string }) {
  const amt = amountText(totals.billable, hide);
  const exactAmt = amountText(totals.exact, hide);
  const pauses = totals.pauseSecs > 0 ? ` · includes ${formatDuration(totals.pauseSecs)} billable pauses` : '';
  return (
    <div className="summary-block" data-testid={`summary-${label.toLowerCase().split(' ')[0]}`}>
      <p className="summary-headline">
        <span className="summary-label">{label}:</span> <strong className="tabular">{amt || formatDuration(totals.billableSecs)}</strong>
        {running && <span className="summary-running tabular">, running {running}</span>}
      </p>
      <p className="muted summary-detail tabular">
        {differs(totals) ? (
          <>
            Billable {formatDuration(totals.billableSecs)}
            {amt && ` (${amt})`} · Exact {formatDuration(totals.exactSecs)}
            {exactAmt && ` (${exactAmt})`}
            {pauses}
          </>
        ) : (
          <>
            {formatDuration(totals.exactSecs)} logged, rounding off{exactAmt && ` (${exactAmt})`}
          </>
        )}
      </p>
    </div>
  );
}

/** The Timeline tab: period totals, then days newest first. */
export function TimelineTab() {
  const { snapshot, nowSec, zones } = useApp();
  const nav = useNav();
  const [count, setCount] = useState(PAGE);
  const hide = snapshot.prefs.hideEarnings;
  const zone = zones.active;
  const client = zones.showBoth ? zones.client : null;

  const book = useMemo(() => new RateBook(snapshot.projects, snapshot.rates), [snapshot.projects, snapshot.rates]);
  const base = useMemo(() => timelineSegs({ segments: snapshot.segments, tasks: snapshot.tasks, gaps: snapshot.gaps }), [snapshot.segments, snapshot.tasks, snapshot.gaps]);
  const raw = useMemo(() => rawIndex(snapshot.rawSegments, zone), [snapshot.rawSegments, zone]);
  const pauseNotes = useMemo(() => new Map(snapshot.pauses.filter((x) => !x.deleted).map((x) => [x.id, x.note])), [snapshot.pauses]);
  const closed = useMemo(() => buildClosed(base, zone, book, snapshot.rounding), [base, zone, book, snapshot.rounding]);
  const overlay = buildOverlay(closed, nowSec, book, snapshot.rounding);

  const projects = useMemo(() => new Map(snapshot.projects.map((p) => [p.id, p])), [snapshot.projects]);
  const tasks = useMemo(() => new Map(snapshot.tasks.map((t) => [t.id, t])), [snapshot.tasks]);
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

  const today = dayOf(nowSec, zone);
  const days = allDays(closed, overlay);
  const shown = days.slice(0, count);

  const todayTotals = totalsOf(dayData(closed, overlay, today).rows);
  const monday = weekStart(today);
  const weekRows = Array.from({ length: 7 }, (_, i) => dayData(closed, overlay, addDays(monday, i)).rows).flat();
  const weekTotals = totalsOf(weekRows);

  // Running cost per minute for each running task, shown next to today's total.
  let perMinute: Numerators = {};
  for (const s of closed.liveSegs) {
    const r = book.at(s.projectId, nowSec);
    if (r.rateCents !== null && r.currency !== null && r.rateCents > 0) perMinute = addNumerators(perMinute, { [r.currency]: r.rateCents * 60 });
  }
  const running = hasAmount(perMinute)
    ? hide
      ? `+${MASK}/min`
      : `+${(['EUR', 'USD'] as const)
          .filter((c) => perMinute[c] !== undefined)
          .map((c) => money(c, centsFromNumerator(perMinute[c] as number)))
          .join(' + ')}/min`
    : undefined;

  return (
    <div className="page timeline" role="region" aria-label="Timeline">
      <div className="summary" aria-label="Period totals">
        <TotalsLine label="Today" totals={todayTotals} hide={hide} running={running} />
        <TotalsLine label="This week" totals={weekTotals} hide={hide} />
        <p className="summary-zone muted">
          {dayLabel(today)}, shown in {zoneLabel(zone, nowSec)}. Weeks start on Monday ({shortDay(monday)}).
        </p>
      </div>
      <Legend />
      {shown.length === 0 && <p className="muted empty">Nothing is logged yet. Create a task, press Start, and its time appears here as a block on today's axis.</p>}
      <div className="days">
        {shown.map((d) => (
          <DayCard
            key={d}
            data={dayData(closed, overlay, d)}
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
            nowSec={d === today ? nowSec : 0}
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
    </div>
  );
}
