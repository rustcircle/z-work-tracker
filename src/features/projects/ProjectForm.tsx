import { useMemo, useState, type FormEvent } from 'react';

import { useApp } from '../../app/store';
import { api } from '../../lib/api';
import { PROJECT_PALETTE, suggestColor } from '../../lib/color';
import { dayOf, startOfDay, toIso, zoneLabel } from '../../lib/tz';
import type { Currency, Project, RateInput } from '../../lib/types';
import { dayLabel } from '../../components/format';
import { RoundingFields, incrementLabel, METHOD_LABEL, type RoundingValue } from '../../components/RoundingFields';
import { Button, Field, Modal } from '../../components/ui';
import { useCommands } from '../../components/useCommands';
import { ZonePickerDialog } from '../zones';
import { centsToInput, parseBudget, parsePrice, rateAt, rateHistory, rateText, validateProjectName } from './projectLogic';

/** Create or edit a project, its price, budget, client zone and rounding override. */
export function ProjectForm({ project, onDone }: { project?: Project; onDone: () => void }) {
  const { snapshot, nowSec, zones } = useApp();
  const { act } = useCommands();
  const today = dayOf(nowSec, zones.active);
  const current = project ? rateAt(snapshot.rates, project.id, nowSec) : null;

  const [name, setName] = useState(project?.name ?? '');
  const [color, setColor] = useState(project?.color ?? suggestColor(snapshot.projects.map((p) => p.color)));
  const [billable, setBillable] = useState(project?.billable ?? true);
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

  const nameError = validateProjectName(name, snapshot.projects, project?.id ?? null);
  const priceResult = parsePrice(price);
  const budgetResult = parseBudget(budget);
  const priceError = billable && !priceResult.ok ? priceResult.error : null;
  const budgetError = budgetResult.ok ? null : budgetResult.error;
  const hasErrors = nameError !== null || priceError !== null || budgetError !== null;

  const history = useMemo(() => (project ? rateHistory(snapshot.rates, project.id) : []), [snapshot.rates, project]);
  const overrides = useMemo(
    () => (project ? snapshot.rounding.filter((r) => r.projectId === project.id && !r.deleted).sort((a, b) => (a.effectiveFrom < b.effectiveFrom ? 1 : -1)) : []),
    [snapshot.rounding, project],
  );

  const rateFromSec = from === 'date' ? startOfDay(fromDate, zones.active) : nowSec;
  const rateChanged = billable && priceResult.ok && (priceResult.cents !== (current?.rateCents ?? null) || (priceResult.cents !== null && currency !== current?.currency));

  function retroactiveNotes(): string[] {
    const notes: string[] = [];
    if (rateChanged && from === 'date' && rateFromSec < nowSec) notes.push(`The price applies from ${dayLabel(fromDate)}, so earnings already shown from then on will change.`);
    if (override && roundFrom < today) notes.push(`The rounding applies from ${dayLabel(roundFrom)}, so billable time already shown from then on will change.`);
    return notes;
  }

  async function run(confirmed: boolean): Promise<void> {
    if (!priceResult.ok && billable) return;
    setBusy(true);
    try {
      const input = { name: name.trim(), color, billable, budgetHours: budgetResult.ok ? budgetResult.hours : null, clientZone };
      let id = project?.id ?? '';
      if (project) {
        if (!(await act(() => api.updateProject(project.id, input)))) return;
      } else {
        const ok = await act(async () => {
          const r = await api.createProject(input);
          id = r.id;
          return r.snapshot;
        });
        if (!ok) return;
      }
      if (rateChanged && priceResult.ok) {
        const body: RateInput = { projectId: id, rateCents: priceResult.cents, currency };
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
        <div className="field">
          <span className="field-label" id="colour-label">
            Colour
          </span>
          <div className="swatches" role="radiogroup" aria-labelledby="colour-label">
            {PROJECT_PALETTE.map((c) => (
              <button key={c} type="button" role="radio" aria-checked={color.toLowerCase() === c} aria-label={`Colour ${c}`} className={`swatch-btn ${color.toLowerCase() === c ? 'on' : ''}`} style={{ background: c }} onClick={() => setColor(c)} />
            ))}
            <label className="swatch-custom" title="Pick any colour">
              <span className="visually-hidden">Custom colour</span>
              <input type="color" value={color} onChange={(e) => setColor(e.target.value)} />
            </label>
            <code className="swatch-hex">{color}</code>
          </div>
        </div>
      </div>

      <label className="check">
        <input type="checkbox" checked={billable} onChange={(e) => setBillable(e.target.checked)} /> Billable project
      </label>

      {billable && (
        <fieldset className="fieldset">
          <legend>Price per hour</legend>
          <div className="row-fields">
            <Field label="Price" error={touched ? priceError : null} hint="Leave blank for no rate. A rate of 0 is allowed.">
              {({ id, describedBy }) => <input id={id} className="input input-narrow" inputMode="decimal" value={price} onChange={(e) => setPrice(e.target.value)} aria-describedby={describedBy} aria-invalid={touched && priceError ? true : undefined} placeholder="e.g. 90" />}
            </Field>
            <Field label="Currency">
              {({ id }) => (
                <select id={id} className="input" value={currency} onChange={(e) => setCurrency(e.target.value as Currency)}>
                  <option value="EUR">EUR (€)</option>
                  <option value="USD">USD ($)</option>
                </select>
              )}
            </Field>
          </div>
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

