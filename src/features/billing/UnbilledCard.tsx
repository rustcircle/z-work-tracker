// Preview of the unbilled time of one project and period, with Copy and Create summary.
import { useEffect, useId, useMemo, useRef, useState } from 'react';

import { useApp } from '../../app/store';
import { useReadOnly } from '../../app/useReadOnly';
import { formatDuration } from '../../components/format';
import { Button, Card, Field } from '../../components/ui';
import { api } from '../../lib/api';
import { MASK } from '../../lib/billing';
import { dayOf } from '../../lib/tz';
import type { Snapshot, SummaryPreview } from '../../lib/types';
import { spanDays, type RangeSpec } from '../analysis/range';
import { FIXED_FEE_TEXT, centsText, feeText, hasCents, noAmountReason, periodText, summaryText } from './billingText';
import { CopyButton, GuidanceLabel, PeriodPicker, RowsTable, chosenZone, defaultPeriod, zoneChoices } from './parts';
import { errorMessage } from '../../lib/errorMessage';

interface Loaded {
  key: string;
  snapshot: Snapshot;
  data: SummaryPreview | null;
  error: string | null;
}

type Outcome = { key: string; kind: 'created'; reference: string; rows: number } | { key: string; kind: 'error'; text: string };

export function UnbilledCard() {
  const { snapshot, nowSec, zones, adopt } = useApp();
  const ro = useReadOnly();
  const readOnlyId = useId();
  const hide = snapshot.prefs.hideEarnings;
  const [projectChoice, setProjectChoice] = useState<string | null>(null);
  const [zoneChoice, setZoneChoice] = useState<string | null>(null);
  // Null until a period is chosen: the one around today until then, and today moves with the clock and the zone.
  const [rangeChoice, setRange] = useState<RangeSpec | null>(null);
  const range = rangeChoice ?? defaultPeriod(dayOf(nowSec, zones.active));
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [busy, setBusy] = useState(false);
  const outcomeRef = useRef<HTMLParagraphElement | null>(null);
  const creating = useRef(false);

  const projects = useMemo(() => [...snapshot.projects].sort((a, b) => Number(a.archived) - Number(b.archived)), [snapshot.projects]);
  // Unbilled and billed time over all periods, per project: the first project with unbilled time is the default.
  const perProject = useMemo(() => {
    const m = new Map<string, { unbilled: number; billed: number }>();
    for (const t of snapshot.tasks) {
      const cur = m.get(t.projectId) ?? { unbilled: 0, billed: 0 };
      cur.unbilled += t.unbilledSecs;
      cur.billed += t.billedSecs;
      m.set(t.projectId, cur);
    }
    return m;
  }, [snapshot.tasks]);
  const auto = useMemo(() => {
    let best: string | null = null;
    let most = -1;
    for (const p of projects) {
      const u = perProject.get(p.id)?.unbilled ?? 0;
      if (!p.archived && u > most) {
        best = p.id;
        most = u;
      }
    }
    return best ?? projects[0]?.id ?? null;
  }, [projects, perProject]);

  const project = projects.find((p) => p.id === (projectChoice ?? '')) ?? projects.find((p) => p.id === auto) ?? null;
  const projectId = project?.id ?? null;
  const zoneOptions = zoneChoices(zones, nowSec, project?.clientZone ?? null);
  const zone = chosenZone(zoneChoice, zoneOptions, project?.clientZone ?? zones.active);
  const span = spanDays(range);
  const key = `${projectId}|${span.fromDay}|${span.toDay}|${zone}`;
  const today = dayOf(nowSec, zone);

  useEffect(() => {
    if (projectId === null) return undefined;
    let alive = true;
    api.summaryPreview({ projectId, from: span.fromDay, to: span.toDay, zone }).then(
      (data) => {
        if (alive) setLoaded({ key, snapshot, data, error: null });
      },
      (e: unknown) => {
        if (alive) setLoaded({ key, snapshot, data: null, error: errorMessage(e) });
      },
    );
    return () => {
      alive = false;
    };
  }, [projectId, span.fromDay, span.toDay, zone, key, snapshot]);

  useEffect(() => {
    if (outcome?.kind === 'created') outcomeRef.current?.focus();
  }, [outcome]);

  const current = loaded && loaded.key === key ? loaded : null;
  const data = current?.data ?? null;
  const noAmount = noAmountReason(project ?? undefined);
  const showAmount = noAmount === null && data !== null && hasCents(data.totals);
  const mine = outcome && outcome.key === key ? outcome : null;
  const hasRows = data !== null && data.rows.length > 0;
  const stats = projectId ? perProject.get(projectId) : undefined;
  // Right after a summary is created the list below still shows the time it just billed, until the preview
  // is read again: pressing Create then would only be refused, and the refusal would replace the answer.
  const settling = mine?.kind === 'created' && current !== null && current.snapshot !== snapshot;

  const text = (): string =>
    data && project
      ? summaryText({ projectName: project.name, noAmount, fee: feeText(project, false), from: span.fromDay, to: span.toDay, zone, rows: data.rows, totals: data.totals, hide, runningExcluded: data.runningExcluded })
      : '';

  async function create(): Promise<void> {
    if (!projectId || creating.current || ro.readOnly) return;
    creating.current = true;
    // Pin what is being billed. Left on its default, the project would move on to whichever has the most
    // unbilled time once this one has none, and the message below would be lost with it.
    setProjectChoice(projectId);
    setZoneChoice(zone);
    setBusy(true);
    setOutcome(null);
    try {
      const r = await api.createSummary({ projectId, from: span.fromDay, to: span.toDay, zone });
      adopt(r.snapshot);
      const made = r.snapshot.billing.summaries.find((s) => s.id === r.id);
      setOutcome({ key, kind: 'created', reference: made?.reference ?? '', rows: made?.rows.length ?? 0 });
    } catch (e) {
      setOutcome({ key, kind: 'error', text: errorMessage(e) });
    } finally {
      creating.current = false;
      setBusy(false);
    }
  }

  if (projects.length === 0) {
    return (
      <Card className="page-card" label="Unbilled time">
        <h3 className="section-title">Unbilled time</h3>
        <GuidanceLabel compact />
        <p className="muted">There are no projects yet. Create a project and track some time to see what is unbilled.</p>
      </Card>
    );
  }

  return (
    <Card className="page-card" label="Unbilled time">
      <h3 className="section-title">Unbilled time</h3>
      <GuidanceLabel compact />
      <div className="bl-controls">
        <Field label="Project">
          {({ id, describedBy }) => (
            <select
              id={id}
              className="input"
              value={projectId ?? ''}
              aria-describedby={describedBy}
              onChange={(e) => {
                setProjectChoice(e.target.value);
                setZoneChoice(null);
              }}
            >
              {projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                  {p.archived ? ' (archived)' : ''}
                </option>
              ))}
            </select>
          )}
        </Field>
        <Field label="Days are cut in" hint="The zone decides which day a segment belongs to. It defaults to the project's client zone.">
          {({ id, describedBy }) => (
            <select id={id} className="input" value={zone} onChange={(e) => setZoneChoice(e.target.value)} aria-describedby={describedBy}>
              {zoneOptions.map((o) => (
                <option key={o.z} value={o.z}>
                  {o.text}
                </option>
              ))}
            </select>
          )}
        </Field>
      </div>
      <PeriodPicker range={range} onChange={setRange} today={today} />
      {stats && (
        <p className="bl-hint" data-testid="billing-project-totals">
          In all periods: <strong>{formatDuration(stats.unbilled)}</strong> unbilled, <strong>{formatDuration(stats.billed)}</strong> on live summaries.
        </p>
      )}

      <div className="bl-result" aria-busy={current === null}>
        {current === null && <p className="muted">Loading…</p>}
        {current?.error && (
          <p className="bl-error" role="alert">
            {current.error}
          </p>
        )}
        {data !== null && data !== undefined && data.unconfirmedSecs > 0 && (
          <p className="bl-notice" role="status" data-testid="billing-unconfirmed">
            <strong>{formatDuration(data.unconfirmedSecs)} of time away has no answer yet</strong> and is left out. Answer it first: once this summary is created, changing that answer means voiding the summary.
          </p>
        )}
        {data?.runningExcluded && (
          <p className="bl-notice" role="status" data-testid="billing-running">
            <strong>A running segment is not included.</strong> Pause or stop the task to include that time in a later summary.
          </p>
        )}
        {data && data.partlyBilledRows > 0 && (
          <p className="bl-notice" role="status" data-testid="billing-partly-billed">
            {data.partlyBilledRows === 1 ? (
              <>
                <strong>Part of this day&apos;s time is already on a summary.</strong> A task&apos;s time on a day rounds once as a whole, so this row bills only the difference.
              </>
            ) : (
              <>
                <strong>Part of these days&apos; time is already on a summary.</strong> A task&apos;s time on a day rounds once as a whole, so these rows bill only the difference.
              </>
            )}
          </p>
        )}
        {data && data.rows.length === 0 && <p className="bl-empty">There is no unbilled time in that period.</p>}
        {data && data.rows.length > 0 && project && (
          <>
            <p className="bl-hint">
              {project.name}, {periodText(span.fromDay, span.toDay, zone)}
            </p>
            <RowsTable rows={data.rows} totals={data.totals} hide={hide} showAmount={showAmount} caption={`Unbilled time of ${project.name}`} />
            <PreviewMoney project={project} noAmount={noAmount} totals={data.totals} hide={hide} />
          </>
        )}
      </div>

      <div className="form-actions" aria-label="Summary actions" role="group">
        <CopyButton key={key} label="Copy" getText={text} disabled={!hasRows} />
        <Button variant="primary" disabled={!hasRows || busy || settling || ro.readOnly} title={ro.why ?? undefined} aria-describedby={ro.readOnly ? readOnlyId : undefined} onClick={() => void create()}>
          {busy ? 'Creating…' : 'Create summary'}
        </Button>
      </div>
      {ro.readOnly && (
        <p className="field-hint" id={readOnlyId} role="status">
          {ro.why} Copy still works.
        </p>
      )}
      {hide && hasRows && <p className="field-hint">Hide earnings is on: the copied text leaves out amounts.</p>}
      {mine?.kind === 'created' && (
        <p ref={outcomeRef} tabIndex={-1} className="bl-created" role="status" data-testid="billing-created">
          Created <strong>{mine.reference}</strong>. The {mine.rows === 1 ? 'row is' : `${mine.rows} rows are`} now marked billed. Void it from the list below to put the time back.
        </p>
      )}
      {mine?.kind === 'error' && (
        <p className="bl-error" role="alert">
          {mine.text}
        </p>
      )}
    </Card>
  );
}

function PreviewMoney({ project, noAmount, totals, hide }: { project: { fixedFeeCents: number | null; feeCurrency: 'EUR' | 'USD' | null; name: string }; noAmount: ReturnType<typeof noAmountReason>; totals: SummaryPreview['totals']; hide: boolean }) {
  if (noAmount === 'fixedFee') {
    const fee = feeText({ fixedFeeCents: project.fixedFeeCents, feeCurrency: project.feeCurrency }, hide);
    return (
      <p className="bl-notice" data-testid="billing-fixed-fee">
        <strong>{FIXED_FEE_TEXT}.</strong> {fee ? <>Agreed fee: <span className="tabular">{fee}</span>.</> : 'No fee has been set for this project.'}
      </p>
    );
  }
  if (noAmount === 'notBillable') return <p className="bl-notice">This project is not billable, so there is no amount.</p>;
  if (!hasCents(totals)) return <p className="bl-notice">No hourly rate applies in this period, so there is no amount.</p>;
  return (
    <p className="bl-total" data-testid="billing-total-amount">
      Total amount: <strong className="tabular">{hide ? MASK : centsText(totals, false)}</strong>
    </p>
  );
}
