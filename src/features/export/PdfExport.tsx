// The PDF timesheet option of the Export dialog: one project or all, a period, the client's zone, a title,
// prices only when asked for, and an optional logo that stays on this computer.
import { useState } from 'react';

import { useApp } from '../../app/store';
import { Button, Field, Switch } from '../../components/ui';
import { api } from '../../lib/api';
import { dayOf, zoneLabel } from '../../lib/tz';
import type { PdfRequest, SelectedEntry } from '../../lib/types';
import { spanDays, type RangeSpec } from '../analysis/range';
import { PeriodPicker, chosenZone, defaultPeriod, zoneChoices } from '../billing/parts';
import '../billing/billing.css';
import { errorMessage } from '../../lib/errorMessage';

export const PDF_CHARACTER_NOTE = 'Latin, Greek and Cyrillic print as typed. Other scripts, such as Japanese or Arabic, and emoji print as an empty box, and the export says when.';

export interface PdfForm {
  projectId: string;
  setProjectId: (id: string) => void;
  range: RangeSpec;
  setRange: (r: RangeSpec) => void;
  zone: string;
  setZone: (z: string) => void;
  title: string;
  setTitle: (t: string) => void;
  includePrices: boolean;
  setIncludePrices: (v: boolean) => void;
  useLogo: boolean;
  setUseLogo: (v: boolean) => void;
  request: PdfRequest;
  /** Set while exporting the selected Timeline entries: project, period and zone then come from the selection. */
  selected: PdfSelection | null;
  busy: boolean;
  result: { path: string | null; unprintable: string[] } | null;
  error: string | null;
  run: () => Promise<void>;
  logoBusy: boolean;
  logoError: string | null;
  chooseLogo: () => Promise<void>;
  removeLogo: () => Promise<void>;
}

/** The Timeline entries picked for export: the PDF covers exactly their days, in the zone they were picked in. */
export interface PdfSelection {
  entries: SelectedEntry[];
  zone: string;
}

export function usePdfForm(selected: PdfSelection | null = null): PdfForm {
  const { snapshot, nowSec, zones, adopt } = useApp();
  const hidden = snapshot.prefs.hideEarnings;
  const [projectId, setProjectIdRaw] = useState('');
  const [zoneChoice, setZoneChoice] = useState<string | null>(null);
  // Null until a period is chosen: the one around today until then. This form is there from the launch on, however long that was ago.
  const [rangeChoice, setRange] = useState<RangeSpec | null>(null);
  const range = rangeChoice ?? defaultPeriod(dayOf(nowSec, zones.active));
  const [titleChoice, setTitleChoice] = useState<string | null>(null);
  // Hide earnings means no prices unless the user turns them on here.
  const [pricesChoice, setPricesChoice] = useState<boolean | null>(null);
  const [logoChoice, setLogoChoice] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<{ key: string; path: string | null; unprintable: string[] } | null>(null);
  const [failed, setFailed] = useState<{ key: string; text: string } | null>(null);
  const [logoBusy, setLogoBusy] = useState(false);
  const [logoError, setLogoError] = useState<string | null>(null);

  const project = snapshot.projects.find((p) => p.id === projectId) ?? null;
  const zone = chosenZone(zoneChoice, zoneChoices(zones, nowSec, project?.clientZone ?? null), project?.clientZone ?? zones.client ?? zones.active);
  const title = titleChoice ?? (project ? `Timesheet: ${project.name}` : 'Timesheet');
  const includePrices = pricesChoice ?? !hidden;
  const useLogo = snapshot.hasPdfLogo && (logoChoice ?? true);
  const span = spanDays(range);
  const days = selected ? selected.entries.map((e) => e.day).sort() : [];
  const request: PdfRequest = selected
    ? { projectId: null, from: days[0] ?? span.fromDay, to: days.at(-1) ?? span.toDay, zone: selected.zone, title: title.trim(), includePrices, useLogo, selection: selected.entries }
    : { projectId: project?.id ?? null, from: span.fromDay, to: span.toDay, zone, title: title.trim(), includePrices, useLogo, selection: null };
  const key = JSON.stringify(request);

  async function run(): Promise<void> {
    setBusy(true);
    setDone(null);
    setFailed(null);
    try {
      setDone({ key, ...(await api.exportPdf(request)) });
    } catch (e) {
      setFailed({ key, text: errorMessage(e) });
    } finally {
      setBusy(false);
    }
  }

  async function logoCall(call: () => Promise<Parameters<typeof adopt>[0]>): Promise<void> {
    setLogoBusy(true);
    setLogoError(null);
    try {
      adopt(await call());
    } catch (e) {
      setLogoError(errorMessage(e));
    } finally {
      setLogoBusy(false);
    }
  }

  return {
    projectId: project?.id ?? '',
    setProjectId: (id) => {
      setProjectIdRaw(id);
      setZoneChoice(null);
    },
    range,
    setRange,
    zone,
    setZone: setZoneChoice,
    title,
    setTitle: setTitleChoice,
    includePrices,
    setIncludePrices: setPricesChoice,
    useLogo,
    setUseLogo: setLogoChoice,
    request,
    busy,
    result: done && done.key === key ? { path: done.path, unprintable: done.unprintable } : null,
    error: failed && failed.key === key ? failed.text : null,
    run,
    selected,
    logoBusy,
    logoError,
    chooseLogo: () => logoCall(() => api.pickPdfLogo()),
    removeLogo: async () => {
      await logoCall(() => api.clearPdfLogo());
      document.getElementById('pdf-choose-logo')?.focus();
    },
  };
}

export function PdfFields({ form }: { form: PdfForm }) {
  const { snapshot, nowSec, zones } = useApp();
  const hidden = snapshot.prefs.hideEarnings;
  const hasLogo = snapshot.hasPdfLogo;
  const project = snapshot.projects.find((p) => p.id === form.projectId) ?? null;
  const today = dayOf(nowSec, form.zone);

  return (
    <div className="pdf-fields">
      <p className="field-hint">A timesheet to send to a client: days, tasks and hours for the period, made on this computer.</p>
      {form.selected ? (
        <p className="field-hint" data-testid="pdf-selection-summary">
          The timesheet covers only the {form.selected.entries.length} selected {form.selected.entries.length === 1 ? 'task' : 'tasks'}, from {form.request.from} to {form.request.to}, with days cut in {zoneLabel(form.selected.zone, nowSec)}. The project, period and zone follow your selection.
        </p>
      ) : (
        <>
      <Field label="Project">
        {({ id, describedBy }) => (
          <select id={id} className="input" value={form.projectId} onChange={(e) => form.setProjectId(e.target.value)} aria-describedby={describedBy}>
            <option value="">All projects</option>
            {snapshot.projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
                {p.archived ? ' (archived)' : ''}
              </option>
            ))}
          </select>
        )}
      </Field>
      <PeriodPicker range={form.range} onChange={form.setRange} today={today} legend="Period" />
      <Field label="Days are cut in" hint="Defaults to the project's client zone.">
        {({ id, describedBy }) => (
          <select id={id} className="input" value={form.zone} onChange={(e) => form.setZone(e.target.value)} aria-describedby={describedBy}>
            {zoneChoices(zones, nowSec, project?.clientZone ?? null).map((o) => (
              <option key={o.z} value={o.z}>
                {o.text}
              </option>
            ))}
          </select>
        )}
      </Field>
        </>
      )}
      <Field label="Title" hint={PDF_CHARACTER_NOTE}>
        {({ id, describedBy }) => <input id={id} className="input" type="text" value={form.title} onChange={(e) => form.setTitle(e.target.value)} aria-describedby={describedBy} autoComplete="off" />}
      </Field>
      <Switch
        label="Include prices"
        checked={form.includePrices}
        onChange={form.setIncludePrices}
        hint={form.includePrices ? 'Rates and amounts are in the file.' : 'No rate, price or amount appears anywhere in the file.'}
      />
      {hidden && form.includePrices && (
        <p className="pdf-note" role="note" data-testid="pdf-prices-note">
          Earnings are hidden on screen, but this PDF will contain prices because you turned them on here.
        </p>
      )}
      {hidden && !form.includePrices && <p className="field-hint">Hide earnings is on, so prices are off by default.</p>}
      <div className="pdf-logo" role="group" aria-label="Logo">
        <Switch label="Print the logo" checked={form.useLogo} disabled={!hasLogo} onChange={form.setUseLogo} />
        <Button small id="pdf-choose-logo" disabled={form.logoBusy} onClick={() => void form.chooseLogo()}>
          Choose logo
        </Button>
        <Button small disabled={!hasLogo || form.logoBusy} onClick={() => void form.removeLogo()}>
          Remove logo
        </Button>
      </div>
      <p className="field-hint" role="status" aria-live="polite">
        {hasLogo ? 'A logo is saved on this computer. It is never synced or uploaded.' : 'No logo yet. Choose a PNG image up to 5 MB; it stays on this computer.'}
      </p>
      {form.logoError && (
        <p className="bl-error" role="alert">
          {form.logoError}
        </p>
      )}
      {form.error && (
        <p className="bl-error" role="alert">
          {form.error}
        </p>
      )}
      {form.result &&
        (form.result.path ? (
          <p className="export-result" role="status" data-testid="pdf-result">
            Saved to <code>{form.result.path}</code>
          </p>
        ) : (
          <p className="muted" role="status" data-testid="pdf-result">
            Cancelled
          </p>
        ))}
      {form.result?.path && form.result.unprintable.length > 0 && (
        <p className="bl-error" role="alert" data-testid="pdf-unprintable">
          {form.result.unprintable.length === 1 ? '1 character prints' : `${form.result.unprintable.length} characters print`} as an empty box in this PDF, as its font has no glyph: {form.result.unprintable.slice(0, 20).join(' ')}
          {form.result.unprintable.length > 20 ? ' and more' : ''}. Copying the text from the PDF still gives them, and the Excel and CSV exports show them.
        </p>
      )}
    </div>
  );
}
