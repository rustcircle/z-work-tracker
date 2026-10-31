// "Add time": time worked that was never tracked, entered by hand in the active zone.
import { useState, type FormEvent } from 'react';

import { useApp } from '../../../app/store';
import { formatDuration } from '../../../components/format';
import { Button, Field } from '../../../components/ui';
import { api } from '../../../lib/api';
import { toIso, zoneLabel } from '../../../lib/tz';
import type { Task } from '../../../lib/types';
import { attempt, sentence } from './attempt';
import { ReasonField, REASON_NEEDED, WallInputs } from './parts';
import { spanText } from './derive';
import { fieldFromInstant, wallToInstant } from './wall';

type Problem = { kind: 'overlap' | 'error'; message: string };

export function AddTimeForm({ task }: { task: Task }) {
  const { zones, nowSec, adopt } = useApp();
  const zone = zones.active;
  const [start, setStart] = useState(() => fieldFromInstant(nowSec - 1800, zone));
  const [end, setEnd] = useState(() => fieldFromInstant(nowSec, zone));
  const [reason, setReason] = useState('');
  const [subtask, setSubtask] = useState('');
  const [busy, setBusy] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<{ start?: string; end?: string; reason?: string }>({});
  const [problem, setProblem] = useState<Problem | null>(null);
  const [done, setDone] = useState<string | null>(null);

  const edited = () => {
    setProblem(null);
    setDone(null);
  };

  const submit = async (allowOverlap: boolean) => {
    const s = wallToInstant(start, zone, 'Start');
    const e = wallToInstant(end, zone, 'End');
    const errors = { start: s.ok ? undefined : s.message, end: e.ok ? undefined : e.message, reason: reason.trim() === '' ? REASON_NEEDED : undefined };
    setFieldErrors(errors);
    setDone(null);
    if (!s.ok || !e.ok || errors.reason) return;
    setBusy(true);
    const r = await attempt(() => api.addManualEntry({ taskId: task.id, start: toIso(s.at), end: toIso(e.at), reason: reason.trim(), subtaskId: subtask === '' ? null : subtask, allowOverlap }));
    setBusy(false);
    if (!r.ok) {
      setProblem({ kind: r.error.code === 'overlap' ? 'overlap' : 'error', message: sentence(r.error.message) });
      return;
    }
    adopt(r.value.snapshot);
    setProblem(null);
    setDone(`Added ${formatDuration(e.at - s.at)} to this task: ${spanText(s.at, e.at, zone)}.`);
    setReason('');
    setFieldErrors({});
  };

  const onSubmit = (ev: FormEvent) => {
    ev.preventDefault();
    void submit(false);
  };

  return (
    <form className="details-form" onSubmit={onSubmit} aria-label="Add time" noValidate>
      <p className="muted details-lead">Time you worked but did not track. It counts like any other time on this task, and the history keeps your reason.</p>
      <p className="field-hint">Times are in {zoneLabel(zone, nowSec)}.</p>
      <div className="form-grid">
        <WallInputs
          legend="Start"
          value={start}
          zone={zone}
          error={fieldErrors.start}
          onChange={(v) => {
            setStart(v);
            edited();
          }}
        />
        <WallInputs
          legend="End"
          value={end}
          zone={zone}
          error={fieldErrors.end}
          onChange={(v) => {
            setEnd(v);
            edited();
          }}
        />
      </div>
      <ReasonField
        value={reason}
        error={fieldErrors.reason}
        onChange={(v) => {
          setReason(v);
          edited();
        }}
      />
      {task.subtasks.length > 0 && (
        <Field label="Subtask (optional)">
          {({ id }) => (
            <select id={id} className="input" value={subtask} onChange={(e) => setSubtask(e.target.value)}>
              <option value="">No subtask</option>
              {task.subtasks.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.text || 'Untitled item'}
                </option>
              ))}
            </select>
          )}
        </Field>
      )}
      <div aria-live="polite" className="details-live">
        {problem?.kind === 'overlap' && (
          <div className="details-warning" role="alert">
            <p>{problem.message}</p>
            <p>Add anyway keeps both entries, and both count.</p>
            <Button small disabled={busy} onClick={() => void submit(true)}>
              Add anyway
            </Button>
          </div>
        )}
        {problem?.kind === 'error' && (
          <p className="field-error" role="alert">
            {problem.message}
          </p>
        )}
        {done && <p className="details-success">{done}</p>}
      </div>
      <div className="form-actions">
        <Button type="submit" variant="primary" disabled={busy}>
          Add time
        </Button>
      </div>
    </form>
  );
}
