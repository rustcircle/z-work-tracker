import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';

import { useApp } from '../../app/store';
import { useReadOnly } from '../../app/useReadOnly';
import { api } from '../../lib/api';
import { MASK } from '../../lib/billing';
import { normalizeHex, suggestColor } from '../../lib/color';
import { useColorNotices } from '../../components/colorNotice';
import { useDirtyGuard } from '../../components/dirtyGuard';
import { useOptionalNav } from '../../components/nav';
import { errorMessage } from '../../lib/errorMessage';
import { rememberColor } from '../../lib/recentColors';
import { dayOf, parseIso, startOfDay, toIso, zoneLabel } from '../../lib/tz';
import type { BillingType, Currency, Project, ProjectInput, RateInput, RateVersion, SavedColor, Snapshot } from '../../lib/types';
import { ColorPicker } from '../../components/ColorPicker';
import { dayLabel } from '../../components/format';
import { RoundingFields, incrementLabel, METHOD_LABEL, type RoundingValue } from '../../components/RoundingFields';
import { Button, ConfirmDialog, Field, Modal, Segmented } from '../../components/ui';
import { useCommands } from '../../components/useCommands';
import { ZonePickerDialog } from '../zones';
import {
  NEEDS_TARGET_RATE_TEXT,
  centsToInput,
  chosenDayBounds,
  laterVersion,
  parseBudget,
  parseFee,
  parsePrice,
  priceFieldsOf,
  rateAt,
  rateHistory,
  rateText,
  savedButNot,
  validateProjectName,
} from './projectLogic';

const HIDDEN_HINT = 'Hidden while Hide earnings is on.';

/** What the form opened with. A form whose values differ from it has changes that are not saved. */
interface Opened {
  name: string;
  color: string;
  billable: boolean;
  billingType: BillingType;
  fee: string;
  feeCurrency: Currency;
  price: string;
  currency: Currency;
  budget: string;
  clientZone: string | null;
}

/**
 * Create or edit a project, its price, budget, client zone and rounding override. `onDirtyChange` hears whether the form has changes
 * that are not saved, for whoever could put another form in its place.
 */
export function ProjectForm({ project, onDone, onDirtyChange }: { project?: Project; onDone: () => void; onDirtyChange?: (dirty: boolean) => void }) {
  const { snapshot, nowSec, zones, adopt } = useApp();
  const { act } = useCommands();
  // Another computer holding the lease refuses every save here. What is typed stays, for after a take over.
  const ro = useReadOnly();
  const notices = useColorNotices();
  const nav = useOptionalNav();
  const colorRef = useRef<HTMLDivElement | null>(null);
  const feeRef = useRef<HTMLInputElement | null>(null);
  const priceRef = useRef<HTMLInputElement | null>(null);
  const historyRef = useRef<HTMLHeadingElement | null>(null);
  const today = dayOf(nowSec, zones.active);
  // A project made by this form: when its price or rounding is refused, the form goes on as the editor of that project, not as a new one.
  const [createdId, setCreatedId] = useState<string | null>(null);
  const saved = project ?? (createdId === null ? undefined : snapshot.projects.find((p) => p.id === createdId));
  const current = saved ? rateAt(snapshot.rates, saved.id, nowSec) : null;
  const hide = snapshot.prefs.hideEarnings;

  const [opened, setOpened] = useState<Opened>(() => ({
    name: project?.name ?? '',
    color: project?.color ?? suggestColor(snapshot.projects.map((p) => p.color)),
    billable: project?.billable ?? true,
    billingType: project?.billingType ?? 'hourly',
    fee: centsToInput(project?.fixedFeeCents ?? null),
    feeCurrency: project?.feeCurrency ?? snapshot.prefs.lastCurrency ?? 'EUR',
    ...priceFieldsOf(current, snapshot.prefs.lastCurrency),
    budget: project?.budgetHours != null ? String(project.budgetHours) : '',
    clientZone: project?.clientZone ?? null,
  }));
  const [name, setName] = useState(opened.name);
  const [color, setColor] = useState(opened.color);
  const [billable, setBillable] = useState(opened.billable);
  const [billingType, setBillingType] = useState<BillingType>(opened.billingType);
  const [fee, setFee] = useState(opened.fee);
  const [feeCurrency, setFeeCurrency] = useState<Currency>(opened.feeCurrency);
  const [serverError, setServerError] = useState<string | null>(null);
  const [price, setPrice] = useState(opened.price);
  const [currency, setCurrency] = useState<Currency>(opened.currency);
  const [from, setFrom] = useState<'now' | 'date'>('now');
  const [fromDate, setFromDate] = useState(today);
  const [budget, setBudget] = useState(opened.budget);
  const [clientZone, setClientZone] = useState<string | null>(opened.clientZone);
  const [pickZone, setPickZone] = useState(false);
  const [override, setOverride] = useState(false);
  const [rounding, setRounding] = useState<RoundingValue>({ minutes: 15, method: 'up' });
  const [roundFrom, setRoundFrom] = useState(today);
  const [touched, setTouched] = useState(false);
  const [confirm, setConfirm] = useState<string[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [removingPrice, setRemovingPrice] = useState<RateVersion | null>(null);
  const [removingRule, setRemovingRule] = useState<string | null>(null);

  // With Hide earnings on, an amount stays masked until the user chooses to change it, so a client looking at the screen does not read it.
  const [unmasked, setUnmasked] = useState({ fee: false, price: false });
  const [seenHide, setSeenHide] = useState(hide);
  if (seenHide !== hide) {
    setSeenHide(hide);
    setUnmasked({ fee: false, price: false });
  }
  const feeMasked = hide && !unmasked.fee && fee !== '';
  const priceMasked = hide && !unmasked.price && price !== '';
  function reveal(which: 'fee' | 'price'): void {
    setUnmasked((u) => ({ ...u, [which]: true }));
    (which === 'fee' ? feeRef : priceRef).current?.focus();
  }

  const colorOf = (c: string): string => normalizeHex(c) ?? c;
  const dirty =
    name !== opened.name ||
    colorOf(color) !== colorOf(opened.color) ||
    billable !== opened.billable ||
    billingType !== opened.billingType ||
    fee !== opened.fee ||
    feeCurrency !== opened.feeCurrency ||
    price !== opened.price ||
    currency !== opened.currency ||
    budget !== opened.budget ||
    clientZone !== opened.clientZone ||
    override;
  useDirtyGuard(dirty);
  useEffect(() => {
    if (!onDirtyChange) return undefined;
    onDirtyChange(dirty);
    return () => onDirtyChange(false);
  }, [dirty, onDirtyChange]);

  // "Choose again" on the replaced-colour notice opens this editor with the cursor in the colour choice.
  const chosen = nav?.colorTarget?.kind === 'project' && project !== undefined && nav.colorTarget.id === project.id;
  const clearColorTarget = nav?.clearColorTarget;
  useEffect(() => {
    if (!chosen) return;
    colorRef.current?.querySelector<HTMLElement>('[role="radio"][tabindex="0"], input, button')?.focus();
    clearColorTarget?.();
  }, [chosen, clearColorTarget]);

  const nameError = validateProjectName(name, snapshot.projects, saved?.id ?? null);
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
  const colorNeighbours = useMemo(() => snapshot.projects.filter((p) => p.id !== saved?.id).map((p) => ({ name: p.name, color: p.color })), [snapshot.projects, saved?.id]);
  // A refusal that is about the colour shows with the picker; any other shows above the buttons.
  const colorError = serverError && /colou?r/i.test(serverError) ? serverError : null;
  const needsYardstick = fixed && priceResult.ok && priceResult.cents === null;

  const savedId = saved?.id;
  const history = useMemo(() => (savedId ? rateHistory(snapshot.rates, savedId) : []), [snapshot.rates, savedId]);
  const overrides = useMemo(
    () => (savedId ? snapshot.rounding.filter((r) => r.projectId === savedId && !r.deleted).sort((a, b) => (a.effectiveFrom < b.effectiveFrom ? 1 : -1)) : []),
    [snapshot.rounding, savedId],
  );
  const dayBounds = chosenDayBounds(zones.active);

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
      const reply = await call();
      adopt(reply.snapshot);
      setServerError(null);
      return reply;
    } catch (e) {
      setServerError(errorMessage(e));
      return null;
    }
  }

  /** A step after the project itself was saved. A refusal shows in the form, with what was saved, and the form stays for another try. */
  async function saveStep(call: () => Promise<Snapshot>, what: 'price' | 'rounding'): Promise<boolean> {
    try {
      adopt(await call());
      return true;
    } catch (e) {
      setServerError(savedButNot(what, errorMessage(e)));
      return false;
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
      const target = saved?.id;
      const result = await saveProject(() => (target ? api.updateProject(target, input) : api.createProject(input)));
      if (!result) return;
      const id = result.id || target || '';
      if (!target && result.id) {
        // From here on this form edits the project it made, and shows the colour it was saved with.
        setCreatedId(result.id);
        setColor(result.color || color);
      }
      rememberColor(result.color || input.color);
      // The backend swapped an exact clash for a random colour: say so, with a way to choose again.
      if (result.replacedFrom) notices.report({ kind: 'project', itemId: id, name: input.name, asked: result.replacedFrom, got: result.color });
      else notices.dismissFor('project', id);
      if (rateChanged && priceResult.ok) {
        const body: RateInput = { projectId: id, rateCents: priceResult.cents, currency: rateCurrency };
        if (from === 'date') {
          body.effectiveFrom = toIso(rateFromSec);
          body.confirmRetroactive = confirmed;
        }
        if (!(await saveStep(() => api.setRate(body), 'price'))) return;
      }
      if (override) {
        const body = { projectId: id, effectiveFrom: roundFrom, incrementMinutes: rounding.minutes, method: rounding.method, confirmRetroactive: confirmed };
        if (!(await saveStep(() => api.setRounding(body, today), 'rounding'))) return;
      }
      onDone();
    } finally {
      setBusy(false);
    }
  }

  /**
   * Takes one price version away. Sending `true` is the confirmation: the user has just answered the question that says what changes.
   * When the price in force changes and nobody changed the price or its currency in the form, both follow it, so Save cannot put the
   * removed price back. A price and its currency are one value: when either was changed, neither follows.
   */
  async function removePrice(version: RateVersion): Promise<void> {
    if (!saved) return;
    const before = rateAt(snapshot.rates, saved.id, nowSec);
    try {
      const next = await api.deleteRateVersion(version.id, true);
      adopt(next);
      setServerError(null);
      const after = rateAt(next.rates, saved.id, nowSec);
      if (before?.id !== after?.id && price === opened.price && currency === opened.currency) {
        const fields = priceFieldsOf(after, next.prefs.lastCurrency);
        setPrice(fields.price);
        setCurrency(fields.currency);
        setOpened((o) => ({ ...o, ...fields }));
      }
      historyRef.current?.focus();
    } catch (e) {
      setServerError(errorMessage(e));
    }
  }

  function submit(e: FormEvent): void {
    e.preventDefault();
    if (ro.readOnly) return;
    setTouched(true);
    if (hasErrors) return;
    const notes = retroactiveNotes();
    if (notes.length > 0) setConfirm(notes);
    else void run(false);
  }

  // The price versions of the project, newest first. A project that is not billable can still hold some (a price no device takes, which
  // the sync warning says to remove here), so they are listed for it too.
  const priceHistory =
    saved && (billable || history.length > 0) ? (
      <div className="rate-history">
        <h4 ref={historyRef} tabIndex={-1}>
          Rate history
        </h4>
        {!billable && <p className="muted">This project is not billable, so these prices are not used.</p>}
        {history.length === 0 ? (
          <p className="muted">No rate has been set yet.</p>
        ) : (
          <ul>
            {history.map((r) => {
              // The day it starts in the zone on screen, as every other date here: its instant is that day's midnight there.
              const day = dayOf(parseIso(r.effectiveFrom), zones.active);
              return (
                <li key={r.id}>
                  <span className="tabular">{hide ? 'Rate hidden' : rateText(r)}</span> <span className="muted">from {day}</span>{' '}
                  <Button small variant="ghost" disabled={ro.readOnly} title={ro.why ?? undefined} onClick={() => setRemovingPrice(r)}>
                    Remove <span className="visually-hidden">the price from {day}</span>
                  </Button>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    ) : null;

  return (
    <form className="project-form" onSubmit={submit} noValidate aria-label={saved ? `Edit project ${saved.name}` : 'New project'}>
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
            <Field label="Fee" error={touched ? feeError : null} hint={feeMasked ? HIDDEN_HINT : 'The agreed price for the whole project. Required.'}>
              {({ id, describedBy }) => (
                <div className="inline-actions">
                  <input
                    id={id}
                    ref={feeRef}
                    className="input input-narrow"
                    inputMode="decimal"
                    value={feeMasked ? MASK : fee}
                    readOnly={feeMasked}
                    onChange={(e) => {
                      setFee(e.target.value);
                      setUnmasked((u) => ({ ...u, fee: true }));
                    }}
                    aria-describedby={describedBy}
                    aria-invalid={touched && feeError ? true : undefined}
                    aria-required="true"
                    placeholder="e.g. 1000"
                  />
                  {feeMasked && (
                    <Button small onClick={() => reveal('fee')}>
                      Change <span className="visually-hidden">the fee</span>
                    </Button>
                  )}
                </div>
              )}
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
            <Field label="Price" error={touched ? priceError : null} hint={priceMasked ? HIDDEN_HINT : fixed ? undefined : 'Leave blank for no rate. A rate of 0 is allowed.'}>
              {({ id, describedBy }) => (
                <div className="inline-actions">
                  <input
                    id={id}
                    ref={priceRef}
                    className="input input-narrow"
                    inputMode="decimal"
                    value={priceMasked ? MASK : price}
                    readOnly={priceMasked}
                    onChange={(e) => {
                      setPrice(e.target.value);
                      setUnmasked((u) => ({ ...u, price: true }));
                    }}
                    aria-describedby={describedBy}
                    aria-invalid={touched && priceError ? true : undefined}
                    placeholder="e.g. 90"
                  />
                  {priceMasked && (
                    <Button small onClick={() => reveal('price')}>
                      Change <span className="visually-hidden">the price</span>
                    </Button>
                  )}
                </div>
              )}
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
                  {({ id, describedBy }) => <input id={id} className="input" type="date" min={dayBounds.min} max={dayBounds.max} value={fromDate} onChange={(e) => e.target.value && setFromDate(e.target.value)} aria-describedby={describedBy} />}
                </Field>
              )}
            </div>
          )}
          {priceHistory}
        </fieldset>
      )}
      {!billable && priceHistory && (
        <fieldset className="fieldset">
          <legend>Price per hour</legend>
          {priceHistory}
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
                <Button small variant="ghost" disabled={ro.readOnly} title={ro.why ?? undefined} onClick={() => setRemovingRule(r.id)}>
                  Remove <span className="visually-hidden">the rule from {r.effectiveFrom}</span>
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
      {ro.readOnly && (
        <p className="validation-note" role="status">
          {ro.why}
        </p>
      )}
      <div className="form-actions">
        <Button variant="primary" type="submit" disabled={busy || ro.readOnly} title={ro.why ?? undefined}>
          {saved ? 'Save project' : 'Create project'}
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
              disabled={ro.readOnly}
              title={ro.why ?? undefined}
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
        {ro.readOnly && <p className="muted">{ro.why}</p>}
      </Modal>
      <ConfirmDialog
        open={removingPrice !== null}
        title="Remove this price?"
        confirmLabel="Remove price"
        danger
        onCancel={() => setRemovingPrice(null)}
        onConfirm={() => {
          const version = removingPrice;
          setRemovingPrice(null);
          if (version) void removePrice(version);
        }}
      >
        {removingPrice && <RemovePriceText version={removingPrice} later={laterVersion(history, removingPrice)} zone={zones.active} nowSec={nowSec} />}
      </ConfirmDialog>
      <ConfirmDialog
        open={removingRule !== null}
        title="Remove this rounding rule?"
        confirmLabel="Remove rule"
        danger
        onCancel={() => setRemovingRule(null)}
        onConfirm={() => {
          const id = removingRule;
          setRemovingRule(null);
          if (id) void act(() => api.deleteRounding(id));
        }}
      >
        <p>Days from that date on fall back to the previous rule. Billable figures for those days change.</p>
      </ConfirmDialog>
    </form>
  );
}

/**
 * What removing a price version does. One that has started changes past earnings, up to the day the next version starts, if there
 * is one; one that has not started changes nothing yet.
 */
function RemovePriceText({ version, later, zone, nowSec }: { version: RateVersion; later: RateVersion | null; zone: string; nowSec: number }) {
  const start = parseIso(version.effectiveFrom);
  const day = dayLabel(dayOf(start, zone));
  if (start > nowSec) return <p>The price from {day} has not started, so no earnings change.</p>;
  const until = later ? dayLabel(dayOf(parseIso(later.effectiveFrom), zone)) : null;
  return (
    <>
      {until ? (
        <p>
          From {day} until {until}, earnings use the price before it, or no price if there is none. From {until} on they stay as they are.
        </p>
      ) : (
        <p>From {day} on, earnings use the price before it, or no price if there is none.</p>
      )}
      <p>Past earnings change, except what is on billing summaries, which keep their amounts.</p>
    </>
  );
}
