// The list of billing summaries, newest first: Copy, Export CSV and Void.
import { useEffect, useMemo, useRef, useState } from 'react';

import { useApp } from '../../app/store';
import { dayLabel, formatDuration } from '../../components/format';
import { Badge, Button, Card, ConfirmDialog, ProjectChip } from '../../components/ui';
import { api } from '../../lib/api';
import { dayOf, parseIso } from '../../lib/tz';
import type { BillingSummary, Project } from '../../lib/types';
import { FIXED_FEE_TEXT, centsText, feeText, hasCents, noAmountReason, pauseNote, periodText, sumRows, summaryText } from './billingText';
import { CopyButton, GuidanceLabel, RowsTable, messageOf } from './parts';

type Note = { id: string; kind: 'saved' | 'cancelled' | 'error'; text: string };

/** Newest first: by creation time, then by number, then by reference so equal stamps stay stable. */
export function newestFirst(list: readonly BillingSummary[]): BillingSummary[] {
  const later = (a: string, b: string): number => (a === b ? 0 : a < b ? 1 : -1);
  return [...list].sort((a, b) => later(a.createdAt, b.createdAt) || b.number - a.number || later(a.reference, b.reference));
}

export function SummariesCard() {
  const { snapshot, zones, adopt } = useApp();
  const hide = snapshot.prefs.hideEarnings;
  const list = useMemo(() => newestFirst(snapshot.billing.summaries), [snapshot.billing.summaries]);
  const projects = useMemo(() => new Map<string, Project>(snapshot.projects.map((p) => [p.id, p])), [snapshot.projects]);
  const [voiding, setVoiding] = useState<BillingSummary | null>(null);
  const [voidError, setVoidError] = useState<string | null>(null);
  const [voidBusy, setVoidBusy] = useState(false);
  const [note, setNote] = useState<Note | null>(null);
  const focusAfter = useRef<string | null>(null);

  // After the dialog closes, put focus on the voided summary: the button that opened it is gone.
  useEffect(() => {
    if (focusAfter.current) {
      document.getElementById(`summary-${focusAfter.current}`)?.focus();
      focusAfter.current = null;
    }
  });

  async function confirmVoid(): Promise<void> {
    if (!voiding) return;
    setVoidBusy(true);
    setVoidError(null);
    try {
      adopt(await api.voidSummary(voiding.id));
      focusAfter.current = voiding.id;
      setVoiding(null);
    } catch (e) {
      setVoidError(messageOf(e));
    } finally {
      setVoidBusy(false);
    }
  }

  async function exportCsv(b: BillingSummary): Promise<void> {
    setNote(null);
    try {
      const path = await api.exportSummaryCsv(b.id);
      setNote(path ? { id: b.id, kind: 'saved', text: `Saved to ${path}` } : { id: b.id, kind: 'cancelled', text: 'Cancelled. Nothing was saved.' });
    } catch (e) {
      setNote({ id: b.id, kind: 'error', text: messageOf(e) });
    }
  }

  return (
    <Card className="page-card" label="Summaries">
      <h3 className="section-title">Summaries</h3>
      <GuidanceLabel compact />
      {list.length === 0 ? (
        <p className="muted" data-testid="billing-no-summaries">
          No summaries yet. Create one from the unbilled time above: it marks that time as billed and gives it a reference.
        </p>
      ) : (
        <ul className="bl-summaries" aria-label="Billing summaries">
          {list.map((b) => {
            const project = projects.get(b.projectId);
            const noAmount = noAmountReason(project);
            const f = sumRows(b.rows);
            const amount = centsText(b.totals, hide);
            const mine = note && note.id === b.id ? note : null;
            return (
              <li key={b.id} id={`summary-${b.id}`} tabIndex={-1} className={`bl-summary ${b.voided ? 'voided' : ''}`} aria-label={`${b.reference}, ${b.voided ? 'voided' : 'live'}`}>
                <div className="bl-summary-head">
                  <h4 className="bl-ref">{b.reference}</h4>
                  <Badge tone={b.voided ? 'danger' : 'success'}>{b.voided ? 'Voided' : 'Live'}</Badge>
                  {project ? <ProjectChip name={project.name} color={project.color} /> : <span className="muted">Unknown project</span>}
                  <span className="bl-hint">
                    {periodText(b.from, b.to, b.zone)}, created {dayLabel(dayOf(parseIso(b.createdAt), zones.active))}
                  </span>
                </div>
                <p className="bl-figures tabular">
                  Exact <strong>{formatDuration(f.exactSecs)}</strong> · Billable <strong>{formatDuration(f.billableSecs)}</strong>
                  {f.pauseSecs > 0 && <span className="bl-note-inline"> ({pauseNote(f.pauseSecs)})</span>}
                  {amount && (
                    <>
                      {' '}
                      · Amount <strong>{amount}</strong>
                    </>
                  )}
                </p>
                {noAmount === 'fixedFee' && project && (
                  <p className="bl-hint">
                    {FIXED_FEE_TEXT}.{feeText(project, hide) ? ` Fee: ${feeText(project, hide)}.` : ''}
                  </p>
                )}
                {b.voided && <p className="bl-hint">Voided: this time is unbilled again. The number {b.reference} is not reused.</p>}
                <details className="bl-details">
                  <summary>
                    {b.rows.length} {b.rows.length === 1 ? 'row' : 'rows'}
                  </summary>
                  <RowsTable rows={b.rows} totals={b.totals} hide={hide} showAmount={noAmount === null && hasCents(b.totals)} caption={`Rows of ${b.reference}`} />
                </details>
                <div className="form-actions">
                  <CopyButton
                    label="Copy"
                    accessibleName={`Copy ${b.reference}`}
                    getText={() =>
                      summaryText({
                        reference: b.reference,
                        voided: b.voided,
                        projectName: project?.name ?? 'Unknown project',
                        noAmount,
                        fee: project ? feeText(project, false) : '',
                        from: b.from,
                        to: b.to,
                        zone: b.zone,
                        rows: b.rows,
                        totals: b.totals,
                        hide,
                      })
                    }
                  />
                  <Button small aria-label={`Export CSV for ${b.reference}`} onClick={() => void exportCsv(b)}>
                    Export CSV
                  </Button>
                  {!b.voided && (
                    <Button
                      small
                      variant="danger"
                      aria-label={`Void ${b.reference}`}
                      onClick={() => {
                        setVoidError(null);
                        setVoiding(b);
                      }}
                    >
                      Void
                    </Button>
                  )}
                </div>
                {mine && (
                  <p className={mine.kind === 'error' ? 'bl-error' : 'bl-flash'} role={mine.kind === 'error' ? 'alert' : 'status'}>
                    {mine.text}
                  </p>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {hide && list.length > 0 && <p className="field-hint">Hide earnings is on: copied text leaves out amounts. A CSV file is written by the app and does contain them.</p>}
      <ConfirmDialog
        open={voiding !== null}
        title={voiding ? `Void ${voiding.reference}?` : 'Void summary?'}
        confirmLabel={voidBusy ? 'Voiding…' : 'Void summary'}
        danger
        onConfirm={() => void confirmVoid()}
        onCancel={() => setVoiding(null)}
      >
        {voiding && (
          <>
            <p>
              The time on <strong>{voiding.reference}</strong> returns to unbilled, so it shows up again in the unbilled time of its period. The number {voiding.reference} is not reused: the next summary gets the next number.
            </p>
            {voidError && (
              <p className="bl-error" role="alert">
                {voidError}
              </p>
            )}
          </>
        )}
      </ConfirmDialog>
    </Card>
  );
}
