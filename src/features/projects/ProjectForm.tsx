import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';

import { useApp } from '../../app/store';
import { api } from '../../lib/api';
import { normalizeHex, suggestColor } from '../../lib/color';
import { useColorNotices } from '../../components/colorNotice';
import { useOptionalNav } from '../../components/nav';
import { errorMessage } from '../../lib/errorMessage';
import { rememberColor } from '../../lib/recentColors';
import { dayOf, startOfDay, toIso, zoneLabel } from '../../lib/tz';
import type { BillingType, Currency, Project, ProjectInput, RateInput, SavedColor } from '../../lib/types';
import { ColorPicker } from '../../components/ColorPicker';
import { dayLabel } from '../../components/format';
import { RoundingFields, incrementLabel, METHOD_LABEL, type RoundingValue } from '../../components/RoundingFields';
import { Button, Field, Modal, Segmented } from '../../components/ui';
import { useCommands } from '../../components/useCommands';
import { ZonePickerDialog } from '../zones';
import { NEEDS_TARGET_RATE_TEXT, centsToInput, parseBudget, parseFee, parsePrice, rateAt, rateHistory, rateText, validateProjectName } from './projectLogic';

/** Create or edit a project, its price, budget, client zone and rounding override. */
export function ProjectForm({ project, onDone }: { project?: Project; onDone: () => void }) {
  const { snapshot, nowSec, zones, adopt } = useApp();
  const { act } = useCommands();
  const notices = useColorNotices();
  const nav = useOptionalNav();
  const colorRef = useRef<HTMLDivElement | null>(null);
  const today = dayOf(nowSec, zones.active);
  const current = project ? rateAt(snapshot.rates, project.id, nowSec) : null;

  const [name, setName] = useState(project?.name ?? '');
  const [color, setColor] = useState(project?.color ?? suggestColor(snapshot.projects.map((p) => p.color)));
  const [billable, setBillable] = useState(project?.billable ?? true);
  const [billingType, setBillingType] = useState<BillingType>(project?.billingType ?? 'hourly');
  const [fee, setFee] = useState(centsToInput(project?.fixedFeeCents ?? null));
  const [feeCurrency, setFeeCurrency] = useState<Currency>(project?.feeCurrency ?? snapshot.prefs.lastCurrency ?? 'EUR');
  const [serverError, setServerError] = useState<string | null>(null);
  const [price, setPrice] = useState(centsToInput(current?.rateCents ?? null));
  const [currency, setCurrency] = useState<Currency>(current && (current.currency === 'EUR' || current.currency === 'USD') ? current.currency : (snapshot.prefs.lastCurrency ?? 'EUR'));
  const [from, setFrom] = useState<'now' | 'date'>('now');
  const [fromDate, setFromDate] = useState(today);
  const [budget, setBudget] = useState(project?.budgetHours != null ? String(project.budgetHours) : '');
  const [clientZone, setClientZone] = useState<string | null>(project?.clientZone ?? null);
  const [pickZone, setPickZone] = useState(false);
  const [override, setOverride] = useState(false);
  const [rounding, setRounding] = useState<RoundingValue>({ minutes: 15, method: 'up' });
  const [roundFrom, setRoundFrom] = useState(today);
  const [touched, setTouched] = useState(false);
  const [confirm, setConfirm] = useState<string[] | null>(null);
  const [busy, setBusy] = useState(false);

  // "Choose again" on the replaced-colour notice opens this editor with the cursor in the colour choice.
  const chosen = nav?.colorTarget?.kind === 'project' && project !== undefined && nav.colorTarget.id === project.id;
  const clearColorTarget = nav?.clearColorTarget;
  useEffect(() => {
    if (!chosen) return;
    colorRef.current?.querySelector<HTMLElement>('[role="radio"][tabindex="0"], input, button')?.focus();
    clearColorTarget?.();
  }, [chosen, clearColorTarget]);

  const nameError = validateProjectName(name, snapshot.projects, project?.id ?? null);
  const fixed = billable && billingType === 'fixedFee';
  const priceResult = parsePrice(price);
  const feeResult = parseFee(fee);
  const budgetResult = parseBudget(budget);
  const priceError = billable && !priceResult.ok ? priceResult.error : null;
  const feeError = fixed && !feeResult.ok ? feeResult.error : null;
  const budgetError = budgetResult.ok ? null : budgetResult.error;
  const hasErrors = nameError !== null || priceError !== null || feeError !== null || budgetError !== null;
  // On a fixed-fee project the price per hour is only a yardstick, and it is kept in the fee's currency.
  const rateCurrency: Currency = fixed ? feeCurrency : currency;
  const colorNeighbours = useMemo(() => snapshot.projects.filter((p) => p.id !== project?.id).map((p) => ({ name: p.name, color: p.color })), [snapshot.projects, project?.id]);
  // A refusal that is about the colour shows with the picker; any other shows above the buttons.
  const colorError = serverError && /colou?r/i.test(serverError) ? serverError : null;
  const needsYardstick = fixed && priceResult.ok && priceResult.cents === null;

  const history = useMemo(() => (project ? rateHistory(snapshot.rates, project.id) : []), [snapshot.rates, project]);
  const overrides = useMemo(
    () => (project ? snapshot.rounding.filter((r) => r.projectId === project.id && !r.deleted).sort((a, b) => (a.effectiveFrom < b.effectiveFrom ? 1 : -1)) : []),
    [snapshot.rounding, project],
  );

  const rateFromSec = from === 'date' ? startOfDay(fromDate, zones.active) : nowSec;
  const rateChanged = billable && priceResult.ok && (priceResult.cents !== (current?.rateCents ?? null) || (priceResult.cents !== null && rateCurrency !== current?.currency));

  function retroactiveNotes(): string[] {
    const notes: string[] = [];
    if (rateChanged && from === 'date' && rateFromSec < nowSec) notes.push(`The price applies from ${dayLabel(fromDate)}, so earnings already shown from then on will change.`);
    if (override && roundFrom < today) notes.push(`The rounding applies from ${dayLabel(roundFrom)}, so billable time already shown from then on will change.`);
    return notes;
  }

  /** Runs the project call and keeps a refusal next to the form, as plain text, instead of only in the app banner. */
  async function saveProject(call: () => Promise<SavedColor>): Promise<SavedColor | null> {
    try {
      const saved = await call();
      adopt(saved.snapshot);
      setServerError(null);
      return saved;
    } catch (e) {
      setServerError(errorMessage(e));
      return null;
    }
  }

  async function run(confirmed: boolean): Promise<void> {
    if (!priceResult.ok && billable) return;
    if (fixed && !feeResult.ok) return;
    setBusy(true);
    try {
      const input: ProjectInput = { name: name.trim(), color: normalizeHex(color) ?? color, billable, budgetHours: budgetResult.ok ? budgetResult.hours : null, clientZone, billingType: 'hourly' };
      if (fixed && feeResult.ok) {
        input.billingType = 'fixedFee';
        input.fixedFeeCents = feeResult.cents;
        input.feeCurrency = feeCurrency;
      }
      const saved = await saveProject(() => (project ? api.updateProject(project.id, input) : api.createProject(input)));
      if (!saved) return;
      const id = saved.id || project?.id || '';
      rememberColor(saved.color || input.color);
      // The backend swapped an exact clash for a random colour: say so, with a way to choose again.
      if (saved.replacedFrom) notices.report({ kind: 'project', itemId: id, name: input.name, asked: saved.replacedFrom, got: saved.color });
      else notices.dismissFor('project', id);
      if (rateChanged && priceResult.ok) {
        const body: RateInput = { projectId: id, rateCents: priceResult.cents, currency: rateCurrency };
        if (from === 'date') {
          body.effectiveFrom = toIso(rateFromSec);
          body.confirmRetroactive = confirmed;
        }
        if (!(await act(() => api.setRate(body)))) return;
      }
      if (override) {
        const body = { projectId: id, effectiveFrom: roundFrom, incrementMinutes: rounding.minutes, method: rounding.method, confirmRetroactive: confirmed };
        if (!(await act(() => api.setRounding(body, today)))) return;
      }
      onDone();
    } finally {
      setBusy(false);
    }
  }

  function submit(e: FormEvent): void {
    e.preventDefault();
    setTouched(true);
    if (hasErrors) return;
    const notes = retroactiveNotes();
    if (notes.length > 0) setConfirm(notes);
    else void run(false);
  }

  return (
    <form className="project-form" onSubmit={submit} noValidate aria-label={project ? `Edit project ${project.name}` : 'New project'}>
      <div className="form-grid">
        <Field label="Project name" error={touched ? nameError : null}>
          {({ id, describedBy }) => <input id={id} className="input" value={name} onChange={(e) => setName(e.target.value)} aria-required="true" aria-invalid={touched && nameError ? true : undefined} aria-describedby={describedBy} autoComplete="off" data-autofocus />}
        </Field>
      </div>

      <div ref={colorRef}>
      <ColorPicker
        label="Colour"
        value={normalizeHex(color) ?? color}
        onChange={setColor}
        sampleName={name.trim() || 'Project name'}
        neighbours={colorNeighbours}
        neighbourNoun="project"
        theme={snapshot.prefs.theme}
        error={colorError}
      />
      </div>

      <label className="check">
        <input type="checkbox" checked={billable} onChange={(e) => setBillable(e.target.checked)} /> Billable project
      </label>

      {billable && (
        <div className="field">
          <span className="field-label">Billing type</span>
          <Segmented
            label="Billing type"
            value={billingType}
            options={[
              { value: 'hourly', label: 'Hourly' },
              { value: 'fixedFee', label: 'Fixed fee' },
            ]}
            onChange={setBillingType}
          />
        </div>
      )}

      {fixed && (
        <fieldset className="fieldset">
          <legend>Fixed fee</legend>
          <div className="row-fields">
            <Field label="Fee" error={touched ? feeError : null} hint="The agreed price for the whole project. Required.">
              {({ id, describedBy }) => <input id={id} className="input input-narrow" inputMode="decimal" value={fee} onChange={(e) => setFee(e.target.value)} aria-describedby={describedBy} aria-invalid={touched && feeError ? true : undefined} aria-required="true" placeholder="e.g. 1000" />}
            </Field>
            <Field label="Fee currency">
              {({ id }) => (
                <select id={id} className="input" value={feeCurrency} onChange={(e) => setFeeCurrency(e.target.value as Currency)}>
                  <option value="EUR">EUR (€)</option>
                  <option value="USD">USD ($)</option>
                </select>
              )}
            </Field>
          </div>
        </fieldset>
      )}

      {billable && (
        <fieldset className="fieldset">
          <legend>{fixed ? 'Price per hour, to measure the fee against' : 'Price per hour'}</legend>
          {fixed && (
            <p className="muted" data-testid="fixed-fee-yardstick">
              A fixed fee still takes a price per hour, only as a yardstick: it values your time so the budget can show how much of the fee is used. It is not billed per hour. It uses the fee&apos;s currency, {feeCurrency}. To value time you have already logged, let the price apply from a date on or before it.
            </p>
          )}
          <div className="row-fields">
            <Field label="Price" error={touched ? priceError : null} hint={fixed ? undefined : 'Leave blank for no rate. A rate of 0 is allowed.'}>
              {({ id, describedBy }) => <input id={id} className="input input-narrow" inputMode="decimal" value={price} onChange={(e) => setPrice(e.target.value)} aria-describedby={describedBy} aria-invalid={touched && priceError ? true : undefined} placeholder="e.g. 90" />}
            </Field>
            {!fixed && (
              <Field label="Currency">
                {({ id }) => (
                  <select id={id} className="input" value={currency} onChange={(e) => setCurrency(e.target.value as Currency)}>
                    <option value="EUR">EUR (€)</option>
                    <option value="USD">USD ($)</option>
                  </select>
                )}
              </Field>
            )}
          </div>
          {needsYardstick && (
            <p className="field-warning" data-testid="needs-target-rate">
              {NEEDS_TARGET_RATE_TEXT}.
            </p>
          )}
          {rateChanged && (
            <div className="row-fields">
              <label className="check">
                <input type="radio" name="rate-from" checked={from === 'now'} onChange={() => setFrom('now')} /> Applies from now
              </label>
              <label className="check">
                <input type="radio" name="rate-from" checked={from === 'date'} onChange={() => setFrom('date')} /> Applies from a date
              </label>
              {from === 'date' && (
                <Field label="From date" hint={fromDate < today ? 'A past date changes earnings already shown. You will be asked to confirm.' : undefined}>
                  {({ id, describedBy }) => <input id={id} className="input" type="date" value={fromDate} onChange={(e) => e.target.value && setFromDate(e.target.value)} aria-describedby={describedBy} />}
                </Field>
              )}
            </div>
          )}
          {project && (
            <div className="rate-history">
              <h4>Rate history</h4>
              {history.length === 0 ? (
                <p className="muted">No rate has been set yet.</p>
              ) : (
                <ul>
                  {history.map((r) => (
                    <li key={r.id}>
                      <span className="tabular">{snapshot.prefs.hideEarnings ? 'Rate hidden' : rateText(r)}</span> <span className="muted">from {r.effectiveFrom.slice(0, 10)}</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </fieldset>
      )}

      <div className="form-grid">
        <Field label="Budget hours" error={touched ? budgetError : null} hint="Optional. Used by the analysis tab to show budget use.">
          {({ id, describedBy }) => <input id={id} className="input input-narrow" inputMode="decimal" value={budget} onChange={(e) => setBudget(e.target.value)} aria-describedby={describedBy} placeholder="none" />}
        </Field>
        <div className="field">
          <span className="field-label">Client time zone for this project</span>
          <div className="inline-actions">
            <span>{clientZone ? zoneLabel(clientZone, nowSec) : zones.client ? `Uses the client zone, ${zoneLabel(zones.client, nowSec)}` : 'None set'}</span>
            <Button small onClick={() => setPickZone(true)}>
              {clientZone ? 'Change zone' : 'Set zone'}
            </Button>
            {clientZone && (
              <Button small variant="ghost" onClick={() => setClientZone(null)}>
                Use the global client zone
              </Button>
            )}
          </div>
        </div>
      </div>

      <fieldset className="fieldset">
        <legend>Rounding for this project</legend>
        {overrides.length > 0 ? (
          <ul className="plain-list">
            {overrides.map((r) => (
              <li key={r.id}>
                From {r.effectiveFrom}: {incrementLabel(r.incrementMinutes)}
                {r.incrementMinutes > 0 && `, ${METHOD_LABEL[r.method]}`}{' '}
                <Button small variant="ghost" onClick={() => void act(() => api.deleteRounding(r.id))}>
                  Remove
                </Button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="muted">This project follows the global rounding in Settings.</p>
        )}
        <label className="check">
          <input type="checkbox" checked={override} onChange={(e) => setOverride(e.target.checked)} /> {overrides.length > 0 ? 'Add another override' : 'Override the global rounding for this project'}
        </label>
        {override && (
          <>
            <RoundingFields legend="Override" value={rounding} onChange={setRounding} />
            <Field label="Effective from" hint={roundFrom < today ? 'A past date changes billable time already shown. You will be asked to confirm.' : undefined}>
              {({ id, describedBy }) => <input id={id} className="input" type="date" value={roundFrom} onChange={(e) => e.target.value && setRoundFrom(e.target.value)} aria-describedby={describedBy} />}
            </Field>
          </>
        )}
      </fieldset>

      {serverError && !colorError && (
        <p className="form-error" role="alert" data-testid="project-error">
          {serverError}
        </p>
      )}
      <div className="form-actions">
        <Button variant="primary" type="submit" disabled={busy}>
          {project ? 'Save project' : 'Create project'}
        </Button>
        <Button variant="ghost" onClick={onDone}>
          Cancel
        </Button>
      </div>

      <ZonePickerDialog open={pickZone} title="Client zone for this project" value={clientZone ?? zones.client} onPick={(z) => { setClientZone(z); setPickZone(false); }} onClose={() => setPickZone(false)} />
      <Modal
        open={confirm !== null}
        title="Change past figures?"
        onClose={() => setConfirm(null)}
        footer={
          <>
            <Button onClick={() => setConfirm(null)}>Go back</Button>
            <Button
              variant="danger"
              onClick={() => {
                setConfirm(null);
                void run(true);
              }}
            >
              Apply to past dates
            </Button>
          </>
        }
      >
        <ul className="plain-list">{confirm?.map((n) => <li key={n}>{n}</li>)}</ul>
        <p className="muted">Raw logged time never changes. Only the derived prices or rounding do.</p>
      </Modal>
    </form>
  );
}

