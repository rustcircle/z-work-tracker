// Quote helper: an estimate for a new job from the user's own finished tasks. The maths lives in
// features/analysis/quote.ts; this is the form and the wording. Hours are shown always, money masked by Hide earnings.
import { useMemo, useState } from 'react';

import { useApp } from '../../app/store';
import { formatDuration } from '../../components/format';
import { Badge, Card, Field, Swatch } from '../../components/ui';
import { MASK, money } from '../../lib/billing';
import { MIN_FOR_QUARTILES, MIN_SAMPLE, quoteFor, type Comparable, type NoAmountReason, type QuoteAmount, type QuoteResult } from '../analysis/quote';
import { GuidanceLabel } from './parts';

const NO_AMOUNT_TEXT: Record<NoAmountReason, string> = {
  noProject: 'Pick a project to see an amount at its hourly rate.',
  fixedFee: 'This project is fixed fee, so there is no hourly amount.',
  notBillable: 'This project is not billable, so there is no amount.',
  noRate: 'This project has no hourly rate yet, so there is no amount.',
};

export function QuoteHelper() {
  const { snapshot, nowSec, zones } = useApp();
  const hide = snapshot.prefs.hideEarnings;
  const [name, setName] = useState('');
  const [tags, setTags] = useState<string[]>([]);
  const [projectId, setProjectId] = useState('');
  const [sameOnly, setSameOnly] = useState(false);
  const liveTags = useMemo(() => snapshot.tags.filter((t) => !t.deleted), [snapshot.tags]);
  const chosenTags = useMemo(() => tags.filter((id) => liveTags.some((t) => t.id === id)), [tags, liveTags]);
  const project = snapshot.projects.find((p) => p.id === projectId) ?? null;
  const minute = Math.floor(nowSec / 60);

  const result = useMemo(
    () => quoteFor(snapshot, { name, tags: chosenTags, projectId: project?.id ?? null, sameProjectOnly: sameOnly }, zones.active, minute * 60),
    [snapshot, name, chosenTags, project?.id, sameOnly, zones.active, minute],
  );

  const toggle = (id: string): void => setTags((cur) => (cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id]));

  return (
    <Card className="page-card" label="Quote helper">
      <h3 className="section-title">Quote helper</h3>
      <GuidanceLabel compact />
      <p className="muted">Describe a new job to see how long similar finished tasks took. It looks at your own stopped tasks and bills nothing.</p>
      <div className="bl-controls">
        <Field label="Job name" hint="Words and tags are matched against your finished tasks.">
          {({ id, describedBy }) => <input id={id} className="input" type="text" value={name} onChange={(e) => setName(e.target.value)} aria-describedby={describedBy} autoComplete="off" />}
        </Field>
        <Field label="Project (optional)" hint="Its hourly rate prices the estimate.">
          {({ id, describedBy }) => (
            <select id={id} className="input" value={project?.id ?? ''} onChange={(e) => setProjectId(e.target.value)} aria-describedby={describedBy}>
              <option value="">No project (hours only)</option>
              {snapshot.projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          )}
        </Field>
      </div>
      {liveTags.length > 0 && (
        <fieldset className="bl-tags">
          <legend>Tags</legend>
          <div className="bl-tag-list">
            {liveTags.map((t) => (
              <label key={t.id} className={`bl-tag ${chosenTags.includes(t.id) ? 'on' : ''}`}>
                <input type="checkbox" checked={chosenTags.includes(t.id)} onChange={() => toggle(t.id)} />
                <Swatch color={t.color} />
                <span>{t.name}</span>
              </label>
            ))}
          </div>
        </fieldset>
      )}
      <label className="check">
        <input type="checkbox" checked={sameOnly && project !== null} disabled={project === null} onChange={(e) => setSameOnly(e.target.checked)} />
        <span>Only compare with tasks of this project</span>
      </label>
      <div aria-live="polite" className="bl-quote">
        <QuoteResultView result={result} hide={hide} tagName={(id) => liveTags.find((t) => t.id === id)?.name ?? id} projectName={(id) => snapshot.projects.find((p) => p.id === id)?.name ?? ''} />
      </div>
    </Card>
  );
}

function QuoteResultView({ result, hide, tagName, projectName }: { result: QuoteResult; hide: boolean; tagName: (id: string) => string; projectName: (id: string) => string }) {
  if (result.kind === 'noCriteria') return <p className="muted">Enter a job name, or pick a tag, to look for similar finished tasks.</p>;
  return (
    <div className="bl-estimate">
      <div className="bl-estimate-head">
        <Badge tone="accent">Estimate</Badge>
        <span className="bl-hint">From your own finished tasks. Billable hours, rounded the way billing rounds them.</span>
      </div>
      {result.kind === 'notEnoughData' ? (
        <p className="bl-notice" data-testid="quote-not-enough">
          <strong>Not enough data.</strong> An estimate needs at least {MIN_SAMPLE} comparable finished tasks; found {result.n}.
        </p>
      ) : (
        <Figures result={result} hide={hide} />
      )}
      {result.skippedZero > 0 && (
        <p className="bl-hint">
          {result.skippedZero === 1 ? '1 matching task has' : `${result.skippedZero} matching tasks have`} no billable time and {result.skippedZero === 1 ? 'is' : 'are'} left out.
        </p>
      )}
      {result.comparables.length > 0 && (
        <>
          <h4>Comparable tasks</h4>
          <ol className="bl-comparables" aria-label="Comparable tasks">
            {result.comparables.map((c) => (
              <ComparableRow key={c.taskId} c={c} tagName={tagName} projectName={projectName} />
            ))}
          </ol>
        </>
      )}
    </div>
  );
}

function ComparableRow({ c, tagName, projectName }: { c: Comparable; tagName: (id: string) => string; projectName: (id: string) => string }) {
  const shared = [...c.sharedTags.map(tagName), ...c.sharedTokens.map((t) => `“${t}”`)];
  return (
    <li className="bl-comparable">
      <span className="bl-comparable-name">{c.name}</span>
      <span className="bl-hint">{projectName(c.projectId)}</span>
      <span className="bl-comparable-hours tabular">{formatDuration(c.billableSecs)}</span>
      <span className="bl-hint">
        {shared.length > 0 ? `Shares ${shared.join(', ')}` : 'Similar'} · match {Math.round(c.score * 100)}%
      </span>
    </li>
  );
}

function Figures({ result, hide }: { result: Extract<QuoteResult, { kind: 'estimate' }>; hide: boolean }) {
  const quartiles = result.p25Secs !== null && result.p75Secs !== null;
  return (
    <>
      <p data-testid="quote-sample">
        Based on <strong>{result.n}</strong> comparable tasks.
      </p>
      <dl className="bl-figs tabular">
        <div>
          <dt>Typical (median)</dt>
          <dd>{formatDuration(result.medianSecs)}</dd>
        </div>
        <div>
          <dt>Range</dt>
          <dd>
            {formatDuration(result.minSecs)} to {formatDuration(result.maxSecs)}
          </dd>
        </div>
        <div>
          <dt>Middle half</dt>
          <dd>{quartiles ? `${formatDuration(result.p25Secs ?? 0)} to ${formatDuration(result.p75Secs ?? 0)}` : `Needs ${MIN_FOR_QUARTILES} or more tasks`}</dd>
        </div>
      </dl>
      <AmountView amount={result.amount} hide={hide} />
    </>
  );
}

function AmountView({ amount, hide }: { amount: QuoteAmount; hide: boolean }) {
  if (amount.kind === 'none') return <p className="bl-hint">{NO_AMOUNT_TEXT[amount.reason]}</p>;
  const m = (cents: number): string => (hide ? MASK : money(amount.currency, cents));
  const mid = amount.p25Cents !== null && amount.p75Cents !== null ? `${m(amount.p25Cents)} to ${m(amount.p75Cents)}` : null;
  return (
    <div data-testid="quote-amount">
      <p className="bl-hint">At the project&apos;s current rate of {hide ? `${MASK}/h` : `${money(amount.currency, amount.rateCents)}/h`}:</p>
      <dl className="bl-figs tabular">
        <div>
          <dt>Typical (median)</dt>
          <dd>{m(amount.medianCents)}</dd>
        </div>
        <div>
          <dt>Range</dt>
          <dd>
            {m(amount.minCents)} to {m(amount.maxCents)}
          </dd>
        </div>
        {mid && (
          <div>
            <dt>Middle half</dt>
            <dd>{mid}</dd>
          </div>
        )}
      </dl>
    </div>
  );
}
