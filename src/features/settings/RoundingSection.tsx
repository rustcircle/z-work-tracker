import { useMemo, useState } from 'react';

import { useApp } from '../../app/store';
import { api } from '../../lib/api';
import { ruleFor } from '../../lib/billing';
import { dayOf } from '../../lib/tz';
import { dayLabel } from '../../components/format';
import { METHOD_LABEL, RoundingFields, incrementLabel, type RoundingValue } from '../../components/RoundingFields';
import { Button, ConfirmDialog, Field } from '../../components/ui';
import { useCommands } from '../../components/useCommands';

export function RoundingSection() {
  const { snapshot, nowSec, zones } = useApp();
  const { act } = useCommands();
  const today = dayOf(nowSec, zones.active);
  const rule = ruleFor(snapshot.rounding, '', today);
  const [value, setValue] = useState<RoundingValue>({ minutes: rule.incrementMinutes, method: rule.method });
  const [from, setFrom] = useState(today);
  const [confirm, setConfirm] = useState(false);
  const [removing, setRemoving] = useState<string | null>(null);

  const versions = useMemo(() => snapshot.rounding.filter((r) => r.projectId === null && !r.deleted).sort((a, b) => (a.effectiveFrom < b.effectiveFrom ? 1 : -1)), [snapshot.rounding]);

  const save = (confirmed: boolean) => void act(() => api.setRounding({ projectId: null, effectiveFrom: from, incrementMinutes: value.minutes, method: value.method, confirmRetroactive: confirmed }, today));

  return (
    <div className="settings-stack">
      <p>
        Billable time is each task's exact time on one day, rounded once for that day in the active zone. It is never rounded per segment. Right now:{' '}
        <strong data-testid="current-rounding">
          {incrementLabel(rule.incrementMinutes)}
          {rule.incrementMinutes > 0 && `, ${METHOD_LABEL[rule.method]}`}
        </strong>
        {versions.length === 0 && ' (the default until you change it)'}.
      </p>
      <RoundingFields legend="New rule" value={value} onChange={setValue} />
      <Field label="Effective from" hint={from < today ? 'This date is in the past. Billable time and earnings already shown from then on will change.' : 'Past days keep the rule that applied to them.'}>
        {({ id, describedBy }) => <input id={id} className="input" type="date" value={from} onChange={(e) => e.target.value && setFrom(e.target.value)} aria-describedby={describedBy} />}
      </Field>
      <div className="form-actions">
        <Button variant="primary" onClick={() => (from < today ? setConfirm(true) : save(false))}>
          Save rounding
        </Button>
      </div>
      <div>
        <h4>Version history</h4>
        {versions.length === 0 ? (
          <p className="muted">No change yet. The default of 15 min, Up applies to every day.</p>
        ) : (
          <ul className="plain-list" aria-label="Rounding versions">
            {versions.map((r) => (
              <li key={r.id} className="version-row">
                <span>
                  From <strong>{r.effectiveFrom}</strong>: {incrementLabel(r.incrementMinutes)}
                  {r.incrementMinutes > 0 && `, ${METHOD_LABEL[r.method]}`}
                </span>
                <Button small variant="ghost" onClick={() => setRemoving(r.id)}>
                  Remove <span className="visually-hidden">the rule from {r.effectiveFrom}</span>
                </Button>
              </li>
            ))}
          </ul>
        )}
      </div>
      <ConfirmDialog
        open={confirm}
        title="Apply to past dates?"
        confirmLabel="Apply to past dates"
        danger
        onCancel={() => setConfirm(false)}
        onConfirm={() => {
          setConfirm(false);
          save(true);
        }}
      >
        <p>
          Starting from {dayLabel(from)} changes billable time and earnings that are already on the timeline. Raw logged time does not change.
        </p>
      </ConfirmDialog>
      <ConfirmDialog
        open={removing !== null}
        title="Remove this rounding rule?"
        confirmLabel="Remove rule"
        danger
        onCancel={() => setRemoving(null)}
        onConfirm={() => {
          const id = removing;
          setRemoving(null);
          if (id) void act(() => api.deleteRounding(id));
        }}
      >
        <p>Days from that date on fall back to the previous rule. Billable figures for those days change.</p>
      </ConfirmDialog>
    </div>
  );
}
