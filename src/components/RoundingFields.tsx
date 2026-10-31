// The rounding increment and method pickers, shared by Settings and the project form.
import { useId, useState } from 'react';

import type { RoundMethod } from '../lib/types';

export const INCREMENT_PRESETS = [0, 1, 5, 6, 10, 15, 30, 60] as const;
export const METHOD_LABEL: Record<RoundMethod, string> = { up: 'Up', nearest: 'Nearest', down: 'Down' };

export const incrementLabel = (m: number): string => (m === 0 ? 'Off (exact time)' : `${m} min`);

export interface RoundingValue {
  minutes: number;
  method: RoundMethod;
}

export function RoundingFields({ value, onChange, legend }: { value: RoundingValue; onChange: (v: RoundingValue) => void; legend: string }) {
  const id = useId();
  const [custom, setCustom] = useState(!(INCREMENT_PRESETS as readonly number[]).includes(value.minutes));
  const selectValue = custom ? 'custom' : String(value.minutes);
  return (
    <fieldset className="fieldset">
      <legend>{legend}</legend>
      <div className="row-fields">
        <div className="field">
          <label className="field-label" htmlFor={`${id}-inc`}>
            Increment
          </label>
          <select
            id={`${id}-inc`}
            className="input"
            value={selectValue}
            onChange={(e) => {
              if (e.target.value === 'custom') {
                setCustom(true);
                onChange({ ...value, minutes: value.minutes > 0 ? value.minutes : 15 });
              } else {
                setCustom(false);
                onChange({ ...value, minutes: Number(e.target.value) });
              }
            }}
          >
            {INCREMENT_PRESETS.map((m) => (
              <option key={m} value={m}>
                {incrementLabel(m)}
              </option>
            ))}
            <option value="custom">Custom minutes…</option>
          </select>
        </div>
        {custom && (
          <div className="field">
            <label className="field-label" htmlFor={`${id}-custom`}>
              Custom minutes
            </label>
            <input
              id={`${id}-custom`}
              className="input input-narrow"
              type="number"
              min={1}
              max={1440}
              step={1}
              value={value.minutes}
              onChange={(e) => onChange({ ...value, minutes: Math.min(1440, Math.max(1, Math.floor(Number(e.target.value)) || 1)) })}
            />
          </div>
        )}
        <div className="field">
          <label className="field-label" htmlFor={`${id}-method`}>
            Method
          </label>
          <select id={`${id}-method`} className="input" value={value.method} disabled={value.minutes === 0} onChange={(e) => onChange({ ...value, method: e.target.value as RoundMethod })}>
            {(Object.keys(METHOD_LABEL) as RoundMethod[]).map((m) => (
              <option key={m} value={m}>
                {METHOD_LABEL[m]}
              </option>
            ))}
          </select>
        </div>
      </div>
    </fieldset>
  );
}
