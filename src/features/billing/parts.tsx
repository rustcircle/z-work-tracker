// Small pieces shared by the Billing tab, the device prefix section and the PDF export.
import { useEffect, useRef, useState } from 'react';

import { Button, Segmented } from '../../components/ui';
import { IconCheck, IconWarn } from '../../components/icons';
import { dayLabel, formatDuration } from '../../components/format';
import type { Zones } from '../../app/store';
import { ROUNDED_ROWS_NOTE, rowsDifferFromTotal } from '../../lib/billing';
import { addDays, zoneLabel } from '../../lib/tz';
import type { SummaryRow } from '../../lib/types';
import { DayInput } from '../analysis/DayInput';
import { defaultRange, labelOf, shiftRange, spanDays, withCustomEnd, MAX_CUSTOM_DAYS, type RangeKind, type RangeSpec } from '../analysis/range';
import { GUIDANCE, centsText, pauseNote, sumRows, type Cents } from './billingText';
import './billing.css';

/** The label every part of the Billing tab carries. */
export function GuidanceLabel({ compact = false }: { compact?: boolean }) {
  return (
    <p className={`bl-guidance ${compact ? 'bl-guidance-compact' : ''}`} data-testid={compact ? undefined : 'billing-guidance'}>
      <IconWarn />
      <strong>{GUIDANCE}</strong>
    </p>
  );
}

/** Per-day rows of a summary: exact, billable (with its pauses) and the amount per currency. */
export function RowsTable({ rows, totals, hide, showAmount, caption }: { rows: readonly SummaryRow[]; totals: Cents; hide: boolean; showAmount: boolean; caption: string }) {
  const f = sumRows(rows);
  return (
    <div className="bl-table-wrap">
      <table className="bl-table tabular">
        <caption className="visually-hidden">{caption}</caption>
        <thead>
          <tr>
            <th scope="col">Day</th>
            <th scope="col">Task</th>
            <th scope="col" className="num">Exact</th>
            <th scope="col" className="num">Billable</th>
            {showAmount && (
              <th scope="col" className="num">
                Amount
              </th>
            )}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={`${r.taskId}|${r.day}`}>
              <td>{dayLabel(r.day)}</td>
              <td>{r.taskName}</td>
              <td className="num">{formatDuration(r.exactSecs)}</td>
              <td className="num">
                {formatDuration(r.billableSecs)}
                {r.pauseSecs > 0 && <span className="bl-note">{pauseNote(r.pauseSecs)}</span>}
              </td>
              {showAmount && <td className="num">{centsText(r.cents, hide) || '–'}</td>}
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr>
            <th scope="row" colSpan={2}>
              Total
            </th>
            <td className="num">{formatDuration(f.exactSecs)}</td>
            <td className="num">
              {formatDuration(f.billableSecs)}
              {f.pauseSecs > 0 && <span className="bl-note">{pauseNote(f.pauseSecs)}</span>}
            </td>
            {showAmount && <td className="num">{centsText(totals, hide) || '–'}</td>}
          </tr>
        </tfoot>
      </table>
      {showAmount && !hide && rowsDifferFromTotal(rows.map((r) => r.cents), totals) && (
        <p className="bl-hint" data-testid="billing-rounded-rows">
          {ROUNDED_ROWS_NOTE}
        </p>
      )}
    </div>
  );
}

type CopyState = { kind: 'idle' } | { kind: 'copied' } | { kind: 'manual' };

/** How long "Copied to the clipboard." stays, so a row in a list does not keep saying it for good. */
export const COPIED_MS = 3000;

/**
 * A Copy button with a visible answer. When the clipboard is unavailable (or refuses), the text is shown
 * selected in a box so the user can copy it by hand; the box always shows the text as it is now, so
 * turning Hide earnings on takes the amounts out of it. "Copied" goes away after a moment. Remount it
 * (change `key`) to clear the answer.
 */
export function CopyButton({ getText, label = 'Copy', accessibleName, disabled = false }: { getText: () => string; label?: string; accessibleName?: string; disabled?: boolean }) {
  const [state, setState] = useState<CopyState>({ kind: 'idle' });
  const box = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    if (state.kind === 'manual') {
      box.current?.focus();
      box.current?.select();
    }
  }, [state]);

  useEffect(() => {
    if (state.kind !== 'copied') return undefined;
    const timer = window.setTimeout(() => setState({ kind: 'idle' }), COPIED_MS);
    return () => window.clearTimeout(timer);
  }, [state]);

  async function copy(): Promise<void> {
    const text = getText();
    try {
      if (typeof navigator === 'undefined' || !navigator.clipboard || typeof navigator.clipboard.writeText !== 'function') throw new Error('no clipboard');
      await navigator.clipboard.writeText(text);
      // A second press starts the countdown again.
      setState({ kind: 'copied' });
    } catch {
      setState({ kind: 'manual' });
    }
  }

  return (
    <>
      <Button small disabled={disabled} aria-label={accessibleName} onClick={() => void copy()}>
        {label}
      </Button>
      <span role="status" aria-live="polite" className="bl-flash">
        {state.kind === 'copied' && (
          <>
            <IconCheck /> Copied to the clipboard.
          </>
        )}
        {state.kind === 'manual' && 'Copying is not available here. The text is selected below: copy it yourself.'}
      </span>
      {state.kind === 'manual' && (
        <textarea ref={box} className="input bl-copy-box" readOnly rows={8} value={getText()} aria-label="Text to copy" onFocus={(e) => e.currentTarget.select()} />
      )}
    </>
  );
}

const PERIOD_KINDS: { kind: RangeKind; label: string }[] = [
  { kind: 'week', label: 'Week' },
  { kind: 'month', label: 'Month' },
  { kind: 'quarter', label: 'Quarter' },
  { kind: 'custom', label: 'Custom' },
];

export const defaultPeriod = (today: string): RangeSpec => ({ kind: 'month', anchor: today });

/** Week, month, quarter or custom days, with previous and next. The same ranges the Analysis tab uses. */
export function PeriodPicker({ range, onChange, today, legend = 'Period' }: { range: RangeSpec; onChange: (r: RangeSpec) => void; today: string; legend?: string }) {
  const span = spanDays(range);
  const setKind = (kind: RangeKind): void => {
    if (kind === 'custom') onChange({ kind, anchor: span.fromDay, from: span.fromDay, to: span.toDay });
    else onChange({ kind, anchor: kind === range.kind ? range.anchor : today >= span.fromDay && today <= span.toDay ? today : span.fromDay });
  };
  return (
    <fieldset className="bl-period">
      <legend>{legend}</legend>
      <div className="bl-row">
        <Segmented value={range.kind} options={PERIOD_KINDS.map((k) => ({ value: k.kind, label: k.label }))} onChange={setKind} label={`${legend} length`} />
        <div className="bl-row">
          <Button small aria-label={`Previous ${legend.toLowerCase()}`} onClick={() => onChange(shiftRange(range, -1))}>
            ‹
          </Button>
          <strong className="bl-period-label tabular" aria-live="polite">
            {labelOf(range.kind, span.fromDay, span.toDay)}
          </strong>
          <Button small aria-label={`Next ${legend.toLowerCase()}`} onClick={() => onChange(shiftRange(range, 1))}>
            ›
          </Button>
          <Button small variant="ghost" onClick={() => onChange(range.kind === 'custom' ? defaultRange(today) : { kind: range.kind, anchor: today })}>
            {range.kind === 'custom' ? 'This week' : 'Today'}
          </Button>
        </div>
      </div>
      {range.kind === 'custom' && (
        <div className="bl-row">
          <label className="bl-inline">
            <span>From</span>
            <DayInput className="input" value={span.fromDay} max={span.toDay} onDay={(day) => onChange(withCustomEnd(range, 'from', day))} />
          </label>
          <label className="bl-inline">
            <span>To</span>
            <DayInput className="input" value={span.toDay} min={span.fromDay} max={addDays(span.fromDay, MAX_CUSTOM_DAYS - 1)} onDay={(day) => onChange(withCustomEnd(range, 'to', day))} />
          </label>
        </div>
      )}
    </fieldset>
  );
}

/**
 * The zone picked in a select, while it is still one of the options; otherwise the default. A select whose value
 * is not among its options shows the first one, so a stale pick would stay in use without being on screen.
 */
export function chosenZone(pick: string | null, options: readonly { z: string }[], fallback: string): string {
  return pick !== null && options.some((o) => o.z === pick) ? pick : fallback;
}

/** One option per distinct zone, named by the roles it plays, with the project's client zone first. */
export function zoneChoices(zones: Zones, nowSec: number, projectZone: string | null): { z: string; text: string }[] {
  const roles = new Map<string, string[]>();
  const add = (z: string | null, role: string): void => {
    if (z) roles.set(z, [...(roles.get(z) ?? []), role]);
  };
  add(projectZone, "project's client zone");
  add(zones.active, 'active zone');
  add(zones.my, 'my zone');
  add(zones.client, 'client zone');
  add('UTC', 'UTC');
  return [...roles.entries()].map(([z, r]) => ({ z, text: `${zoneLabel(z, nowSec)} (${r.join(', ')})` }));
}
