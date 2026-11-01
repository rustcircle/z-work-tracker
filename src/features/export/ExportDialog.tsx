import { useMemo, useState } from 'react';

import { useApp } from '../../app/store';
import { api } from '../../lib/api';
import { toSegs } from '../../lib/split';
import { zoneLabel } from '../../lib/tz';
import type { ExportRequest } from '../../lib/types';
import { Button, Field, Modal, Segmented, Switch } from '../../components/ui';
import { useSelection } from '../timeline/selection';
import { IconDownload } from '../../components/icons';
import { buildAnalyticsSheets } from '../analysis/sheets';
import { PdfFields, usePdfForm } from './PdfExport';
import { segmentShiftText } from './segmentShifts';
import { errorMessage } from '../../lib/errorMessage';

type Kind = 'xlsx' | 'csv' | 'pdf';

/** Excel or CSV export of everything logged, cut into days in the chosen zone, or a PDF timesheet. */
export function ExportDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { snapshot, zones, nowSec, showError } = useApp();
  const sel = useSelection();
  const [scopeChoice, setScopeChoice] = useState<'all' | 'selected' | null>(null);
  const [wasOpen, setWasOpen] = useState(open);
  // Each time the dialog opens it starts on the selected entries, if there are any.
  if (wasOpen !== open) {
    setWasOpen(open);
    if (open) setScopeChoice(null);
  }
  const selectedCount = sel?.count ?? 0;
  const scope: 'all' | 'selected' = scopeChoice ?? (selectedCount > 0 ? 'selected' : 'all');
  const bySelection = scope === 'selected';
  const picked = useMemo(() => (bySelection && sel ? { entries: sel.entries, zone: sel.zone } : null), [bySelection, sel]);
  const [kind, setKind] = useState<Kind>('xlsx');
  const [dayZone, setDayZone] = useState<string | null>(null);
  const [withClient, setWithClient] = useState(true);
  const [earnings, setEarnings] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ path: string | null } | null>(null);
  const pdf = usePdfForm(picked);

  // The days of a selection are cut in the zone it was made in, so that zone is not a choice.
  const zone = picked ? picked.zone : (dayZone ?? zones.active);
  const includeEarnings = earnings ?? !snapshot.prefs.hideEarnings;
  const hidden = snapshot.prefs.hideEarnings;

  // One option per distinct zone, named by the roles it plays.
  const roles = new Map<string, string[]>();
  const add = (z: string, role: string) => roles.set(z, [...(roles.get(z) ?? []), role]);
  add(zones.active, 'active zone');
  add(zones.my, 'my zone');
  if (zones.client) add(zones.client, 'client zone');
  add('UTC', 'UTC');
  const zoneOptions = [...roles.entries()].map(([z, r]) => ({ z, text: `${zoneLabel(z, nowSec)} (${r.join(', ')})` }));

  const blocked = bySelection && selectedCount === 0;

  async function run(): Promise<void> {
    if (blocked) return;
    if (kind === 'pdf') return pdf.run();
    setBusy(true);
    setResult(null);
    try {
      const request: ExportRequest = {
        dayZone: zone,
        myZone: zones.my,
        clientZone: withClient ? zones.client : null,
        includeEarnings,
        segmentShifts: segmentShiftText(toSegs(snapshot, nowSec), snapshot.shifts),
        // A selection exports only its own rows: the backend leaves the analysis sheets out, so none are built.
        analytics: kind === 'xlsx' && !picked ? buildAnalyticsSheets(snapshot, zone, nowSec).filter((s) => includeEarnings || !s.containsPrices) : [],
        selection: picked ? picked.entries : null,
      };
      const path = await (kind === 'xlsx' ? api.exportXlsx(request) : api.exportCsv(request));
      setResult({ path });
    } catch (e) {
      showError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open={open}
      title="Export"
      wide={kind === 'pdf'}
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Close</Button>
          <Button variant="primary" icon={<IconDownload />} disabled={busy || pdf.busy || blocked} onClick={() => void run()}>
            {busy || pdf.busy ? 'Exporting…' : `Export ${kind === 'xlsx' ? 'Excel' : kind === 'pdf' ? 'PDF' : 'CSV'}`}
          </Button>
        </>
      }
    >
      <div className="settings-stack">
        <Segmented
          label="Scope"
          value={scope}
          onChange={(v) => {
            setScopeChoice(v);
            setResult(null);
          }}
          options={[
            { value: 'all', label: 'All in period' },
            { value: 'selected', label: `Selected (${selectedCount})` },
          ]}
        />
        {bySelection && selectedCount > 0 && (
          <p className="field-hint" data-testid="selection-scope-note">
            Only the {selectedCount} {selectedCount === 1 ? 'task' : 'tasks'} you selected on the Timeline go into the file, each for the day you selected it on. {kind === 'xlsx' ? 'The analysis sheets are left out, and an "About this selection" sheet says so. ' : kind === 'csv' ? 'A final "selection" row says so. ' : 'The timesheet says so. '}
            Totals are worked out from those rows only, rounded per task and day exactly as on the Timeline. A task still running is counted up to the moment of export.
          </p>
        )}
        {blocked && (
          <p className="bl-error" role="alert" data-testid="selection-empty">
            Nothing is selected. Select entries on the Timeline, or choose All in period.
          </p>
        )}
        <Segmented
          label="Format"
          value={kind}
          onChange={(k) => {
            setKind(k);
            setResult(null);
          }}
          options={[
            { value: 'xlsx', label: 'Excel (.xlsx)' },
            { value: 'csv', label: 'CSV (.csv)' },
            { value: 'pdf', label: 'PDF timesheet (.pdf)' },
          ]}
        />
        {kind === 'pdf' ? (
          <PdfFields form={pdf} />
        ) : (
          <>
            <Field label="Cut days in" hint="Raw times are always exported in UTC as well. This zone decides which day a segment belongs to.">
              {({ id, describedBy }) => (
                <select id={id} className="input" value={zone} disabled={picked !== null} onChange={(e) => setDayZone(e.target.value)} aria-describedby={describedBy}>
                  {zoneOptions.map((o) => (
                    <option key={o.z} value={o.z}>
                      {o.text}
                    </option>
                  ))}
                </select>
              )}
            </Field>
            {zones.client && <Switch label={`Include ${zoneLabel(zones.client, nowSec)} times`} checked={withClient} onChange={setWithClient} hint="Adds client-zone columns next to My zone." />}
            <Switch
              label="Include earnings"
              checked={includeEarnings}
              onChange={setEarnings}
              hint={includeEarnings ? (hidden ? 'Earnings are hidden on screen, but this file will contain them.' : 'Prices and amounts are in the file.') : 'Turn off for client-facing files: no rates, prices or amounts, and analysis sheets with money are left out.'}
            />
            {kind === 'xlsx' && !picked && <p className="field-hint">The Excel file also holds analysis sheets for the same zone.</p>}
            {picked && <p className="field-hint">The days are the ones you selected, cut in {zoneLabel(picked.zone, nowSec)}.</p>}
            {result &&
              (result.path ? (
                <p className="export-result" role="status" data-testid="export-result">
                  Saved to <code>{result.path}</code>
                </p>
              ) : (
                <p className="muted" role="status">
                  Export cancelled. Nothing was saved.
                </p>
              ))}
          </>
        )}
        {bySelection && sel && selectedCount > 0 && (result?.path || pdf.result?.path) && (
          <p className="field-hint" data-testid="selection-after-export">
            The selection is kept, in case you want the same entries in another format.{' '}
            <Button small onClick={sel.clear}>
              Clear selection
            </Button>
          </p>
        )}
      </div>
    </Modal>
  );
}
