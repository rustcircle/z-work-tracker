// "Pauses": the gaps between the task's segments, and the choice to bill one as time still worked.
// A billable pause counts in Billable and never in Exact.
import { useId, useMemo, useState, type FormEvent } from 'react';

import { useAppState } from '../../../app/store';
import { useReadOnly } from '../../../app/useReadOnly';
import { formatDuration } from '../../../components/format';
import { Badge, Button } from '../../../components/ui';
import { api } from '../../../lib/api';
import { parseIso, toIso } from '../../../lib/tz';
import type { BillablePause, Task } from '../../../lib/types';
import { attempt, sentence } from './attempt';
import { BILLED_REASON } from './CorrectionsList';
import { billedPauseIds, dayText, derivePauses, pauseRows, timesText, type Span } from './derive';
import { dayOf } from '../../../lib/tz';

const FIRST = 10;

export function PausesList({ task }: { task: Task }) {
  const { snapshot, zones } = useAppState();
  const ro = useReadOnly();
  const zone = zones.active;
  const [all, setAll] = useState(false);
  const [betweenDays, setBetweenDays] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const spans = useMemo(() => derivePauses(snapshot.rawSegments, task), [snapshot.rawSegments, task]);
  const { rows, orphans } = useMemo(() => pauseRows(spans, snapshot.pauses, task.id), [spans, snapshot.pauses, task.id]);
  const billed = useMemo(() => billedPauseIds(snapshot.billing.summaries), [snapshot.billing.summaries]);
  // A gap that spans days is the night or the weekend, not a pause in the work: it stays out of the way
  // unless asked for, but a pause already billed is always listed so it can be undone.
  const sameDay = (r: { span: Span; marked: readonly BillablePause[] }): boolean => r.marked.length > 0 || dayOf(r.span.start, zone) === dayOf(r.span.end, zone);
  const hiddenBetweenDays = rows.filter((r) => !sameDay(r)).length;
  const listed = (betweenDays ? rows : rows.filter(sameDay)).slice().reverse();
  const shown = all ? listed : listed.slice(0, FIRST);

  return (
    <div className="details-stack">
      <p className="details-lead">
        Billable pause time on this task: <strong className="tabular">{formatDuration(task.pauseSecs)}</strong>. A billable pause counts in Billable but not in Exact, so a wait you were paid for can be billed without claiming you worked it.
      </p>
      {ro.readOnly && (
        <p className="details-note" role="status">
          {ro.why}
        </p>
      )}
      <div aria-live="polite" className="details-live">
        {notice && <p className="details-success">{notice}</p>}
      </div>
      {listed.length === 0 && orphans.length === 0 && <p className="muted">No pauses {hiddenBetweenDays > 0 ? 'within a day' : 'yet'}. A pause is the gap between two stretches of work on this task.</p>}
      {shown.length > 0 && (
        <ul className="pause-list" aria-label="Pauses">
          {shown.map((r) => (
            <PauseItem key={`${r.span.start}-${r.span.end}`} span={r.span} marked={r.marked} billed={billed} zone={zone} taskId={task.id} onNotice={setNotice} />
          ))}
        </ul>
      )}
      <div className="inline-actions">
        {listed.length > FIRST && (
          <Button small onClick={() => setAll((v) => !v)}>
            {all ? 'Show recent pauses only' : `Show all ${listed.length} pauses`}
          </Button>
        )}
        {hiddenBetweenDays > 0 && (
          <Button small aria-pressed={betweenDays} onClick={() => setBetweenDays((v) => !v)}>
            {betweenDays ? 'Hide gaps between days' : `Show ${hiddenBetweenDays} ${hiddenBetweenDays === 1 ? 'gap' : 'gaps'} between days`}
          </Button>
        )}
      </div>
      {orphans.length > 0 && (
        <section aria-label="Billed pauses outside the gaps">
          <h4 className="details-sub">Billed pauses that no longer match a gap</h4>
          <p className="muted">Time was corrected after these were marked. You can still undo them.</p>
          <ul className="pause-list">
            {orphans.map((p) => (
              <PauseItem key={p.id} span={{ start: parseIso(p.start), end: parseIso(p.end) }} marked={[p]} billed={billed} zone={zone} taskId={task.id} onNotice={setNotice} />
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

function PauseItem({ span, marked, billed, zone, taskId, onNotice }: { span: Span; marked: BillablePause[]; billed: ReadonlySet<string>; zone: string; taskId: string; onNotice: (t: string | null) => void }) {
  const textId = useId();
  return (
    <li className="pause-row" data-pause-start={span.start}>
      <div className="pause-head" id={textId}>
        <strong>{dayText(span, zone)}</strong>
        <span className="tabular">{timesText(span, zone)}</span>
        <span className="muted tabular">{formatDuration(span.end - span.start)}</span>
      </div>
      {marked.length === 0 ? (
        <BillForm span={span} taskId={taskId} describedBy={textId} zone={zone} onNotice={onNotice} />
      ) : (
        marked.map((p) => <MarkedPause key={p.id} pause={p} billed={billed.has(p.id)} zone={zone} describedBy={textId} onNotice={onNotice} />)
      )}
    </li>
  );
}

function BillForm({ span, taskId, describedBy, zone, onNotice }: { span: Span; taskId: string; describedBy: string; zone: string; onNotice: (t: string | null) => void }) {
  const { adopt } = useAppState();
  const ro = useReadOnly();
  const noteId = useId();
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  const submit = async () => {
    if (ro.readOnly) return;
    setBusy(true);
    const r = await attempt(() => api.markBillablePause({ taskId, start: toIso(span.start), end: toIso(span.end), note: note.trim() }));
    setBusy(false);
    if (!r.ok) {
      setProblem(sentence(r.error.message));
      return;
    }
    adopt(r.value.snapshot);
    onNotice(`Billed the pause ${timesText(span, zone)} (${formatDuration(span.end - span.start)}) as time worked.`);
  };

  return (
    <form
      className="pause-form"
      onSubmit={(ev: FormEvent) => {
        ev.preventDefault();
        void submit();
      }}
    >
      <label htmlFor={noteId} className="visually-hidden">
        Note (optional)
      </label>
      <input
        id={noteId}
        className="input"
        type="text"
        maxLength={500}
        placeholder="Note (optional), for example: waiting on the client"
        value={note}
        onChange={(e) => {
          setNote(e.target.value);
          setProblem(null);
        }}
        aria-describedby={describedBy}
        autoComplete="off"
      />
      <Button type="submit" small disabled={busy || ro.readOnly} title={ro.why ?? undefined} aria-describedby={describedBy}>
        Bill this pause
      </Button>
      {problem && (
        <p className="field-error pause-error" role="alert">
          {problem}
        </p>
      )}
    </form>
  );
}

function MarkedPause({ pause, billed, zone, describedBy, onNotice }: { pause: BillablePause; billed: boolean; zone: string; describedBy: string; onNotice: (t: string | null) => void }) {
  const { adopt } = useAppState();
  const ro = useReadOnly();
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const span = { start: parseIso(pause.start), end: parseIso(pause.end) };

  const undo = async () => {
    setBusy(true);
    const r = await attempt(() => api.unmarkBillablePause(pause.id));
    setBusy(false);
    if (!r.ok) {
      setProblem(sentence(r.error.message));
      return;
    }
    adopt(r.value);
    onNotice(`Undid the billable pause ${timesText(span, zone)}. It no longer counts in Billable.`);
  };

  return (
    <div className="pause-marked">
      <div className="pause-marked-text">
        <Badge tone="success">Billed as pause</Badge>
        <span className="tabular muted">{timesText(span, zone)}</span>
        {pause.note && <span className="pause-note">Note: {pause.note}</span>}
      </div>
      {billed ? (
        <p className="details-note">{BILLED_REASON}.</p>
      ) : (
        <Button small disabled={busy || ro.readOnly} title={ro.why ?? undefined} aria-describedby={describedBy} onClick={() => void undo()}>
          Undo
        </Button>
      )}
      {problem && (
        <p className="field-error pause-error" role="alert">
          {problem}
        </p>
      )}
    </div>
  );
}
