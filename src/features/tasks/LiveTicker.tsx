import { useMemo } from 'react';

import { useApp } from '../../app/store';
import { RateBook } from '../../lib/billing';
import { toSegs } from '../../lib/split';
import type { Project, Task } from '../../lib/types';
import { amountText, formatDuration, formatHMS } from '../../components/format';
import { useNav } from '../../components/nav';
import { liveFigures } from './taskLive';

/** Running task: session clock, today's exact and billable time, and earnings that tick and step. */
export function LiveTicker({ task, project }: { task: Task; project: Project }) {
  const { snapshot, nowSec, zones } = useApp();
  const nav = useNav();
  const hide = snapshot.prefs.hideEarnings;
  const book = useMemo(() => new RateBook(snapshot.projects, snapshot.rates), [snapshot.projects, snapshot.rates]);
  const base = useMemo(
    () => toSegs({ segments: snapshot.segments.filter((s) => s.taskId === task.id), tasks: [task] }, 0),
    [snapshot.segments, task],
  );
  const segs = base.map((s) => (s.live ? { ...s, end: Math.max(nowSec, s.start) } : s));
  const f = liveFigures(segs, nowSec, zones.active, book, snapshot.rounding);
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
          </dd>
        </div>
        <div>
          <dt>Today, billable{inc ? ` (${inc})` : ''}</dt>
          <dd className="tabular">{formatDuration(f.billableSecs)}</dd>
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
          {project.billable ? (
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
