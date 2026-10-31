import { useMemo } from 'react';

import { useApp } from '../../app/store';
import { MASK, RateBook, money } from '../../lib/billing';
import type { Project, Task } from '../../lib/types';
import { amountText, formatDuration, formatHMS } from '../../components/format';
import { useNav } from '../../components/nav';
import { piecesOf } from './taskFigures';
import { liveFigures, liveSpans } from './taskLive';

/** Running task: session clock, today's exact and billable time, and earnings that tick and step. */
export function LiveTicker({ task, project }: { task: Task; project: Project }) {
  const { snapshot, nowSec, zones } = useApp();
  const nav = useNav();
  const hide = snapshot.prefs.hideEarnings;
  const book = useMemo(() => new RateBook(snapshot.projects, snapshot.rates), [snapshot.projects, snapshot.rates]);
  // The task's own pieces. Work and thinking are worked time; a billable pause is billable only.
  const pieces = piecesOf(snapshot.segments, task.id);
  const spans = liveSpans(pieces, task.projectId, nowSec);
  const f = liveFigures(spans, nowSec, zones.active, book, snapshot.rounding);
  const fixedFee = project.billable && project.billingType === 'fixedFee';
  const fee = fixedFee && project.fixedFeeCents !== null && project.feeCurrency !== null ? money(project.feeCurrency, project.fixedFeeCents) : null;
  const rated = f.rate.rateCents !== null;
  const inc = f.rule && f.rule.incrementMinutes > 0 ? `${f.rule.incrementMinutes} min, ${f.rule.method === 'up' ? 'Up' : f.rule.method === 'down' ? 'Down' : 'Nearest'}` : null;

  return (
    <div className="ticker" aria-label="Live time and earnings">
      <div className="ticker-main">
        <span className="ticker-dot" aria-hidden="true" />
        <span className="ticker-clock tabular" title="Time in the current session">
          {formatHMS(f.sessionSecs)}
        </span>
        <span className="muted">this session</span>
      </div>
      <dl className="ticker-grid">
        <div>
          <dt>Today, exact</dt>
          <dd className="tabular" title={formatHMS(f.exactSecs)}>
            {formatDuration(f.exactSecs)}
            {f.thinkingSecs > 0 && <span className="muted ticker-sub"> includes {formatDuration(f.thinkingSecs)} thinking</span>}
          </dd>
        </div>
        <div>
          <dt>Today, billable{inc ? ` (${inc})` : ''}</dt>
          <dd className="tabular">
            {formatDuration(f.billableSecs)}
            {f.pauseSecs > 0 && <span className="muted ticker-sub"> includes {formatDuration(f.pauseSecs)} billable pauses</span>}
          </dd>
        </div>
        {rated && (
          <>
            <div>
              <dt>Exact accrual (ticks)</dt>
              <dd className="tabular">{amountText(f.exactNumerators, hide) || '—'}</dd>
            </div>
            <div>
              <dt>Billable now{inc ? ' (steps)' : ''}</dt>
              <dd className="tabular">{amountText(f.billableNumerators, hide) || '—'}</dd>
            </div>
          </>
        )}
      </dl>
      {!rated && (
        <p className="muted ticker-note">
          {fixedFee ? (
            <>
              Fixed fee{fee ? <>: <span className="tabular">{hide ? MASK : fee}</span></> : ''}. Hourly earnings are not counted.
            </>
          ) : project.billable ? (
            <>
              No rate set.{' '}
              <button type="button" className="link" onClick={() => nav.openProject(project.id)}>
                Set a rate
              </button>
            </>
          ) : (
            'Non-billable project.'
          )}
        </p>
      )}
    </div>
  );
}
