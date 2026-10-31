// Small pieces shared by the sections of the task details dialog.
import type { ReactNode } from 'react';

import { Field } from '../../../components/ui';
import { abbrAt, formatOffset, offsetAt } from '../../../lib/tz';
import { clock } from '../../../components/format';
import { repeated, type WallField } from './wall';

/** A date, a time and, when the wall time happens twice, a choice of which of the two. */
export function WallInputs({ legend, value, onChange, zone, error }: { legend: string; value: WallField; onChange: (v: WallField) => void; zone: string; error?: string | null }) {
  const twice = repeated(value, zone);
  return (
    <fieldset className="fieldset wall-field">
      <legend>{legend}</legend>
      <div className="row-fields">
        <Field label={`${legend} date`}>{({ id }) => <input id={id} className="input" type="date" value={value.day} onChange={(e) => onChange({ ...value, day: e.target.value })} />}</Field>
        <Field label={`${legend} time`}>{({ id }) => <input id={id} className="input" type="time" value={value.time} onChange={(e) => onChange({ ...value, time: e.target.value })} />}</Field>
        {twice && (
          <Field label={`${legend} happens twice (clocks go back). Which one?`}>
            {({ id }) => (
              <select id={id} className="input" value={value.second ? 'second' : 'first'} onChange={(e) => onChange({ ...value, second: e.target.value === 'second' })}>
                <option value="first">
                  {clock(twice.first, zone)} {abbrAt(twice.first, zone)}, {formatOffset(offsetAt(twice.first, zone))} (first)
                </option>
                <option value="second">
                  {clock(twice.second, zone)} {abbrAt(twice.second, zone)}, {formatOffset(offsetAt(twice.second, zone))} (second)
                </option>
              </select>
            )}
          </Field>
        )}
      </div>
      {error && (
        <p className="field-error" role="alert">
          {error}
        </p>
      )}
    </fieldset>
  );
}

/** A reason box. Required by this page even though the backend would store an empty one. */
export function ReasonField({ label = 'Reason', value, onChange, error, hint }: { label?: string; value: string; onChange: (v: string) => void; error?: string | null; hint?: ReactNode }) {
  return (
    <Field label={label} error={error} hint={hint}>
      {({ id, describedBy }) => <input id={id} className="input" type="text" maxLength={500} value={value} onChange={(e) => onChange(e.target.value)} aria-invalid={error ? true : undefined} aria-describedby={describedBy} autoComplete="off" />}
    </Field>
  );
}

export const REASON_NEEDED = 'Say why, so the history makes sense later.';
