// "Corrections": every recorded segment of the task, what counts now beside what was recorded, and the
// actions that change it. The recorded (raw) time is always shown, and nothing here deletes it.
import { useId, useState, type FormEvent } from 'react';

import { useAppState } from '../../../app/store';
import { useReadOnly } from '../../../app/useReadOnly';
import { clock, dayLabel, formatDuration } from '../../../components/format';
import { TimerButton } from '../../../components/TimerButton';
import { Badge, Button } from '../../../components/ui';
import { api } from '../../../lib/api';
import { dayOf, parseIso, toIso } from '../../../lib/tz';
import type { RawSegment, Task } from '../../../lib/types';
import { AuditList, useAudit } from './AuditList';
import { attempt, sentence } from './attempt';
import { timesText } from './derive';
import { ReasonField, REASON_NEEDED, WallInputs } from './parts';
import { fieldFromInstant, wallToInstant } from './wall';

export const BILLED_REASON = 'This time is on a billing summary; void that summary first';

type Mode = 'correct' | 'void' | 'restore' | 'history' | 'settle';

export function CorrectionsList({ task }: { task: Task }) {
  const { snapshot, zones } = useAppState();
  const ro = useReadOnly();
  const zone = zones.active;
  const [open, setOpen] = useState<{ id: string; mode: Mode } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const rows = snapshot.rawSegments.filter((s) => s.taskId === task.id).sort((a, b) => (a.rawStart < b.rawStart ? 1 : a.rawStart > b.rawStart ? -1 : 0));

  if (rows.length === 0) return <p className="muted">No time has been recorded on this task yet. Use Add time to enter some.</p>;
  return (
    <div className="details-stack">
      <p className="muted details-lead">
        What counts is shown beside what was recorded. A correction never deletes the recorded time, and Restore brings it back.
      </p>
      {ro.readOnly && (
        <p className="details-note" role="status">
          {ro.why}
        </p>
      )}
      <div aria-live="polite" className="details-live">
        {notice && <p className="details-success">{notice}</p>}
      </div>
      <ul className="seg-list" aria-label="Recorded time">
        {rows.map((s) => (
          <SegmentRow
            key={s.id}
            seg={s}
            device={task.runningElsewhere}
            zone={zone}
            mode={open?.id === s.id ? open.mode : null}
            onMode={(mode) => {
              setNotice(null);
              setOpen(mode ? { id: s.id, mode } : null);
            }}
            onDone={(text) => {
              setOpen(null);
              setNotice(text);
            }}
          />
        ))}
      </ul>
    </div>
  );
}

function SegmentRow({ seg, device, zone, mode, onMode, onDone }: { seg: RawSegment; device: string | null; zone: string; mode: Mode | null; onMode: (m: Mode | null) => void; onDone: (text: string) => void }) {
  const { snapshot } = useAppState();
  const ro = useReadOnly();
  const rawStart = parseIso(seg.rawStart);
  const rawEnd = seg.rawEnd === null ? null : parseIso(seg.rawEnd);
  const effStart = parseIso(seg.start);
  const effEnd = seg.end === null ? null : parseIso(seg.end);
  // No recorded end means it is still running for the computer that owns it, unless a correction closed it from another one
  // (a settlement, or a void): then it counts, or doesn't, by that, and it can be corrected like any other time.
  const running = seg.rawEnd === null && !seg.corrected && !seg.voided;
  // Another computer's timer, which may be gone for good. The backend decides whether it is (see `SettleForm`).
  const elsewhere = running && seg.deviceId !== snapshot.deviceId;
  const rawText = rawEnd === null ? (running ? `${clock(rawStart, zone)} to now` : `${clock(rawStart, zone)}, no recorded end`) : timesText({ start: rawStart, end: rawEnd }, zone);
  const nowText = seg.voided ? 'Not counted' : effEnd === null ? 'Still running' : timesText({ start: effStart, end: effEnd }, zone);
  const secs = seg.voided || effEnd === null ? 0 : effEnd - effStart;
  const textId = useId();
  const name = `${dayLabel(dayOf(rawStart, zone))}, ${rawText}`;
  const changed = seg.corrected || seg.voided;
  // Restore goes back to the recorded times, and a segment closed from another computer has no recorded end to go back to.
  // So a void of one is undone by a correction.
  const canRestore = changed && seg.rawEnd !== null;
  const canCorrect = !seg.voided || seg.rawEnd === null;
  const why = ro.why ?? undefined;

  return (
    <li className={`seg-row ${seg.voided ? 'seg-voided' : ''}`} data-segment-id={seg.id}>
      <div className="seg-head" id={textId}>
        <strong>{dayLabel(dayOf(rawStart, zone))}</strong>
        <span className="seg-badges">
          {seg.manual && <Badge tone="accent">Added by hand</Badge>}
          {seg.corrected && <Badge tone="warning">Corrected</Badge>}
          {seg.voided && <Badge tone="danger">Voided</Badge>}
          {seg.billed && <Badge tone="success">Billed</Badge>}
        </span>
      </div>
      <dl className="seg-times">
        <div>
          <dt>Counts as</dt>
          <dd className="tabular">
            {nowText}
            {secs > 0 && <span className="muted"> ({formatDuration(secs)})</span>}
          </dd>
        </div>
        <div>
          <dt>Recorded</dt>
          <dd className="tabular">
            {rawText}
            {rawEnd !== null && <span className="muted"> ({formatDuration(rawEnd - rawStart)})</span>}
          </dd>
        </div>
      </dl>
      {seg.reason && <p className="seg-reason">Reason: {seg.reason}</p>}

      {running && <p className="muted">Still running. Pause or stop the task before you correct this time.</p>}
      {elsewhere && (
        <div className="inline-actions">
          <Button small aria-describedby={textId} aria-expanded={mode === 'settle'} disabled={ro.readOnly} title={why} onClick={() => onMode(mode === 'settle' ? null : 'settle')}>
            Close at last known time
          </Button>
        </div>
      )}
      {!running && seg.billed && <p className="details-note">{BILLED_REASON}.</p>}
      {!running && !seg.billed && (
        <div className="inline-actions">
          {canCorrect && (
            <Button small aria-describedby={textId} aria-expanded={mode === 'correct'} disabled={ro.readOnly} title={why} onClick={() => onMode(mode === 'correct' ? null : 'correct')}>
              Correct
            </Button>
          )}
          {!seg.voided && (
            <Button small aria-describedby={textId} aria-expanded={mode === 'void'} disabled={ro.readOnly} title={why} onClick={() => onMode(mode === 'void' ? null : 'void')}>
              Void
            </Button>
          )}
          {canRestore && (
            <Button small aria-describedby={textId} aria-expanded={mode === 'restore'} disabled={ro.readOnly} title={why} onClick={() => onMode(mode === 'restore' ? null : 'restore')}>
              Restore
            </Button>
          )}
        </div>
      )}
      <div className="inline-actions">
        <button type="button" className="link" aria-expanded={mode === 'history'} aria-describedby={textId} onClick={() => onMode(mode === 'history' ? null : 'history')}>
          History
        </button>
      </div>

      {mode === 'settle' && elsewhere && <SettleForm seg={seg} device={device} name={name} onCancel={() => onMode(null)} onDone={onDone} />}
      {mode === 'correct' && <CorrectForm seg={seg} zone={zone} name={name} onCancel={() => onMode(null)} onDone={onDone} />}
      {(mode === 'void' || mode === 'restore') && <ReasonOnlyForm seg={seg} kind={mode} name={name} onCancel={() => onMode(null)} onDone={onDone} />}
      {mode === 'history' && <SegmentHistory id={seg.id} name={name} />}
    </li>
  );
}

function SegmentHistory({ id, name }: { id: string; name: string }) {
  const { entries, error } = useAudit(id);
  return (
    <div className="seg-history">
      <AuditList entries={entries} error={error} label={`History of ${name}`} showAbout={false} />
    </div>
  );
}

function CorrectForm({ seg, zone, name, onCancel, onDone }: { seg: RawSegment; zone: string; name: string; onCancel: () => void; onDone: (text: string) => void }) {
  const { adopt } = useAppState();
  const ro = useReadOnly();
  const [start, setStart] = useState(() => fieldFromInstant(parseIso(seg.start), zone));
  const [end, setEnd] = useState(() => fieldFromInstant(parseIso(seg.end ?? seg.start), zone));
  const [reason, setReason] = useState('');
  const [errors, setErrors] = useState<{ start?: string; end?: string; reason?: string }>({});
  const [problem, setProblem] = useState<{ overlap: boolean; message: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (allowOverlap: boolean) => {
    // What is typed stays for after a take over; nothing is sent meanwhile.
    if (ro.readOnly) return;
    // An end nobody touched is sent as it is recorded, seconds included: the inputs only hold minutes.
    const s = wallToInstant(start, zone, 'Start', parseIso(seg.start));
    const e = wallToInstant(end, zone, 'End', parseIso(seg.end ?? seg.start));
    const next = { start: s.ok ? undefined : s.message, end: e.ok ? undefined : e.message, reason: reason.trim() === '' ? REASON_NEEDED : undefined };
    setErrors(next);
    if (!s.ok || !e.ok || next.reason) return;
    setBusy(true);
    const r = await attempt(() => api.correctSegment({ segmentId: seg.id, start: toIso(s.at), end: toIso(e.at), reason: reason.trim(), allowOverlap }));
    setBusy(false);
    if (!r.ok) {
      setProblem({ overlap: r.error.code === 'overlap', message: sentence(r.error.message) });
      return;
    }
    adopt(r.value);
    onDone(`Corrected ${name}. The recorded time is kept.`);
  };

  const changed = () => setProblem(null);
  return (
    <form
      className="details-form seg-form"
      aria-label={`Correct ${name}`}
      noValidate
      onSubmit={(ev: FormEvent) => {
        ev.preventDefault();
        void submit(false);
      }}
    >
      <div className="form-grid">
        <WallInputs
          legend="New start"
          value={start}
          zone={zone}
          error={errors.start}
          onChange={(v) => {
            setStart(v);
            changed();
          }}
        />
        <WallInputs
          legend="New end"
          value={end}
          zone={zone}
          error={errors.end}
          onChange={(v) => {
            setEnd(v);
            changed();
          }}
        />
      </div>
      <ReasonField
        value={reason}
        error={errors.reason}
        onChange={(v) => {
          setReason(v);
          changed();
        }}
      />
      <div aria-live="polite" className="details-live">
        {problem?.overlap && (
          <div className="details-warning" role="alert">
            <p>{problem.message}</p>
            <p>Correct anyway keeps both, and both count.</p>
            <Button small disabled={busy || ro.readOnly} title={ro.why ?? undefined} onClick={() => void submit(true)}>
              Correct anyway
            </Button>
          </div>
        )}
        {problem && !problem.overlap && (
          <p className="field-error" role="alert">
            {problem.message}
          </p>
        )}
      </div>
      {ro.readOnly && (
        <p className="details-note" role="status">
          {ro.why}
        </p>
      )}
      <div className="form-actions">
        <Button type="submit" variant="primary" disabled={busy || ro.readOnly} title={ro.why ?? undefined}>
          Save correction
        </Button>
        <Button onClick={onCancel}>Cancel</Button>
      </div>
    </form>
  );
}

function ReasonOnlyForm({ seg, kind, name, onCancel, onDone }: { seg: RawSegment; kind: 'void' | 'restore'; name: string; onCancel: () => void; onDone: (text: string) => void }) {
  const { adopt } = useAppState();
  const ro = useReadOnly();
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const verb = kind === 'void' ? 'Void' : 'Restore';

  const submit = async () => {
    if (ro.readOnly) return;
    if (reason.trim() === '') {
      setError(REASON_NEEDED);
      return;
    }
    setError(null);
    setBusy(true);
    const r = await attempt(() => (kind === 'void' ? api.voidSegment(seg.id, reason.trim()) : api.restoreSegment(seg.id, reason.trim())));
    setBusy(false);
    if (!r.ok) {
      setProblem(sentence(r.error.message));
      return;
    }
    adopt(r.value);
    onDone(kind === 'void' ? `Voided ${name}. It no longer counts, and the recorded time is kept.` : `Restored ${name} to the recorded time.`);
  };

  return (
    <form
      className="details-form seg-form"
      aria-label={`${verb} ${name}`}
      noValidate
      onSubmit={(ev: FormEvent) => {
        ev.preventDefault();
        void submit();
      }}
    >
      <p className="muted">{kind === 'void' ? 'Voided time is left out of every report and total. You can restore it later.' : 'Restore removes the correction or the void and counts the recorded time again.'}</p>
      <ReasonField
        value={reason}
        error={error}
        onChange={(v) => {
          setReason(v);
          setProblem(null);
        }}
      />
      <div aria-live="polite" className="details-live">
        {problem && (
          <p className="field-error" role="alert">
            {problem}
          </p>
        )}
      </div>
      {ro.readOnly && (
        <p className="details-note" role="status">
          {ro.why}
        </p>
      )}
      <div className="form-actions">
        <Button type="submit" variant={kind === 'void' ? 'danger' : 'primary'} disabled={busy || ro.readOnly} title={ro.why ?? undefined}>
          Confirm {verb.toLowerCase()}
        </Button>
        <Button onClick={onCancel}>Cancel</Button>
      </div>
    </form>
  );
}

/**
 * Close another computer's open segment at the last moment it is known to have been running it (`settle_lost_segment`), for a
 * computer that is gone or never came back. Never automatic. The backend allows it once that computer was asked to pause the task, or
 * has written nothing for a day, and says so in its refusal otherwise: the page can't tell how long a computer has been silent.
 */
function SettleForm({ seg, device, name, onCancel, onDone }: { seg: RawSegment; device: string | null; name: string; onCancel: () => void; onDone: (text: string) => void }) {
  const { snapshot, zones, adopt } = useAppState();
  const ro = useReadOnly();
  const [reason, setReason] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const other = device ?? 'the other computer';
  // The end it gets is the one already shown for this time: its last known moment, and nothing after a request to pause.
  const piece = snapshot.segments.find((p) => p.segmentId === seg.id && p.end === null);
  const ends = piece?.provisionalEnd ? clock(parseIso(piece.provisionalEnd), zones.active) : null;

  const submit = async () => {
    if (ro.readOnly) return;
    setBusy(true);
    const r = await attempt(() => api.settleLostSegment(seg.id, reason.trim()));
    setBusy(false);
    if (!r.ok) {
      setProblem(sentence(r.error.message));
      return;
    }
    adopt(r.value);
    onDone(`Closed ${name} at its last known time. The history says so.`);
  };

  return (
    <form
      className="details-form seg-form"
      aria-label={`Close ${name} at its last known time`}
      noValidate
      onSubmit={(ev: FormEvent) => {
        ev.preventDefault();
        void submit();
      }}
    >
      <p className="muted">
        {ends ? `This ends the time at ${ends}, the last moment ${other} is known to have been running it.` : `This ends the time at the last moment ${other} is known to have been running it.`} That works once {other} was asked to pause the task (Pause it from here, on the task), or has said nothing for 24 hours. Before then {other} may still be running it.
      </p>
      <p className="muted">
        The history records it. If {other} kept working, its own record replaces this when it next syncs, unless the time is already on a billing summary.
      </p>
      <ReasonField
        label="Reason (optional)"
        value={reason}
        hint={`Left blank, the history says: Closed from ${snapshot.deviceName}: ${other} stopped responding. Ended at its last known moment.`}
        onChange={(v) => {
          setReason(v);
          setProblem(null);
        }}
      />
      <div aria-live="polite" className="details-live">
        {problem && (
          <p className="field-error" role="alert">
            {problem}
          </p>
        )}
      </div>
      {ro.readOnly && (
        <p className="details-note" role="status">
          {ro.why}
        </p>
      )}
      <div className="form-actions">
        <TimerButton type="submit" variant="primary" disabled={busy || ro.readOnly} title={ro.why ?? undefined}>
          Confirm close
        </TimerButton>
        <Button onClick={onCancel}>Cancel</Button>
      </div>
    </form>
  );
}
