// "Corrections": every recorded segment of the task, what counts now beside what was recorded, and the
// actions that change it. The recorded (raw) time is always shown, and nothing here deletes it.
import { useId, useState, type FormEvent } from 'react';

import { useApp } from '../../../app/store';
import { clock, dayLabel, formatDuration } from '../../../components/format';
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

type Mode = 'correct' | 'void' | 'restore' | 'history';

export function CorrectionsList({ task }: { task: Task }) {
  const { snapshot, zones } = useApp();
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
      <div aria-live="polite" className="details-live">
        {notice && <p className="details-success">{notice}</p>}
      </div>
      <ul className="seg-list" aria-label="Recorded time">
        {rows.map((s) => (
          <SegmentRow
            key={s.id}
            seg={s}
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

function SegmentRow({ seg, zone, mode, onMode, onDone }: { seg: RawSegment; zone: string; mode: Mode | null; onMode: (m: Mode | null) => void; onDone: (text: string) => void }) {
  const rawStart = parseIso(seg.rawStart);
  const rawEnd = seg.rawEnd === null ? null : parseIso(seg.rawEnd);
  const effStart = parseIso(seg.start);
  const effEnd = seg.end === null ? null : parseIso(seg.end);
  const running = seg.rawEnd === null;
  const rawText = rawEnd === null ? `${clock(rawStart, zone)} to now` : timesText({ start: rawStart, end: rawEnd }, zone);
  const nowText = seg.voided ? 'Not counted' : effEnd === null ? 'Still running' : timesText({ start: effStart, end: effEnd }, zone);
  const secs = seg.voided || effEnd === null ? 0 : effEnd - effStart;
  const textId = useId();
  const name = `${dayLabel(dayOf(rawStart, zone))}, ${rawText}`;
  const changed = seg.corrected || seg.voided;

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
      {!running && seg.billed && <p className="details-note">{BILLED_REASON}.</p>}
      {!running && !seg.billed && (
        <div className="inline-actions">
          {!seg.voided && (
            <Button small aria-describedby={textId} aria-expanded={mode === 'correct'} onClick={() => onMode(mode === 'correct' ? null : 'correct')}>
              Correct
            </Button>
          )}
          {!seg.voided && (
            <Button small aria-describedby={textId} aria-expanded={mode === 'void'} onClick={() => onMode(mode === 'void' ? null : 'void')}>
              Void
            </Button>
          )}
          {changed && (
            <Button small aria-describedby={textId} aria-expanded={mode === 'restore'} onClick={() => onMode(mode === 'restore' ? null : 'restore')}>
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
  const { adopt } = useApp();
  const [start, setStart] = useState(() => fieldFromInstant(parseIso(seg.start), zone));
  const [end, setEnd] = useState(() => fieldFromInstant(parseIso(seg.end ?? seg.start), zone));
  const [reason, setReason] = useState('');
  const [errors, setErrors] = useState<{ start?: string; end?: string; reason?: string }>({});
  const [problem, setProblem] = useState<{ overlap: boolean; message: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (allowOverlap: boolean) => {
    const s = wallToInstant(start, zone, 'Start');
    const e = wallToInstant(end, zone, 'End');
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
            <Button small disabled={busy} onClick={() => void submit(true)}>
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
      <div className="form-actions">
        <Button type="submit" variant="primary" disabled={busy}>
          Save correction
        </Button>
        <Button onClick={onCancel}>Cancel</Button>
      </div>
    </form>
  );
}

function ReasonOnlyForm({ seg, kind, name, onCancel, onDone }: { seg: RawSegment; kind: 'void' | 'restore'; name: string; onCancel: () => void; onDone: (text: string) => void }) {
  const { adopt } = useApp();
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const verb = kind === 'void' ? 'Void' : 'Restore';

  const submit = async () => {
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
      <div className="form-actions">
        <Button type="submit" variant={kind === 'void' ? 'danger' : 'primary'} disabled={busy}>
          Confirm {verb.toLowerCase()}
        </Button>
        <Button onClick={onCancel}>Cancel</Button>
      </div>
    </form>
  );
}
