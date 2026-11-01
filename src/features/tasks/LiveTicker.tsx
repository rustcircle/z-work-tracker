import { useMemo } from 'react';

import { useAppState, useLiveSec } from '../../app/store';
import { nextWake, useStepNow } from '../../app/stepClock';
import { MASK, RateBook, money } from '../../lib/billing';
import { dayBounds, dayOf, parseIso } from '../../lib/tz';
import type { Project, Task } from '../../lib/types';
import { amountText, formatDuration, formatHMS } from '../../components/format';
import { useNav } from '../../components/nav';
import { piecesOf } from './taskFigures';
import { liveFigures, liveSpans } from './taskLive';

/** The running task's elapsed clock: the one number in the app that follows the shared 1 s tick. */
function SessionClock({ since }: { since: number }) {
  const sec = useLiveSec();
  return (
    <span className="ticker-clock tabular" title="Time in the current session" data-testid="session-clock">
      {formatHMS(Math.max(0, sec - since))}
    </span>
  );
}

/** Whole minutes: a figure that moves only when a minute or a step is due should not show stale seconds. */
const wholeMinutes = (secs: number): number => Math.floor(secs / 60) * 60;

/**
 * Running task: the session clock, today's exact and billable time, and the Billable amount. The amount
 * changes only when the billable time steps (15 minutes by default), never second by second, and the figures
 * are worked out again only when a step falls due, a minute completes, or data changes.
 */
export function LiveTicker({ task, project }: { task: Task; project: Project }) {
  const { snapshot, zones } = useAppState();
  const nav = useNav();
  const hide = snapshot.prefs.hideEarnings;
  const book = useMemo(() => new RateBook(snapshot.projects, snapshot.rates), [snapshot.projects, snapshot.rates]);
  // The task's own pieces. Work and thinking are worked time; a billable pause is billable only.
  const pieces = piecesOf(snapshot.segments, task.id);
  const open = pieces.find((p) => p.end === null && p.provisionalEnd === null && (p.kind ?? 'work') !== 'billablePause');
  const since = open ? parseIso(open.start) : null;
  const zone = zones.active;
  const figuresAt = (at: number) => liveFigures(liveSpans(pieces, task.projectId, at), at, zone, book, snapshot.rounding);

  const now = useStepNow(snapshot, (at) => {
    if (since === null) return null;
    const f = figuresAt(at);
    const rows = f.rule ? [{ counted: f.countedSecs, rule: f.rule }] : [];
    return nextWake(rows, at, since, dayBounds(dayOf(at, zone), zone).end - at);
  });
  const f = figuresAt(now);
  const fixedFee = project.billable && project.billingType === 'fixedFee';
  const fee = fixedFee && project.fixedFeeCents !== null && project.feeCurrency !== null ? money(project.feeCurrency, project.fixedFeeCents) : null;
  const rated = f.rate.rateCents !== null;
  const inc = f.rule && f.rule.incrementMinutes > 0 ? `${f.rule.incrementMinutes} min, ${f.rule.method === 'up' ? 'Up' : f.rule.method === 'down' ? 'Down' : 'Nearest'}` : null;

  return (
    <div className="ticker" aria-label="Live time and earnings">
      <div className="ticker-main">
        <span className="ticker-dot" aria-hidden="true" />
        {since !== null ? <SessionClock since={since} /> : <span className="ticker-clock tabular">0:00:00</span>}
        <span className="muted">this session</span>
      </div>
      <dl className="ticker-grid">
        <div>
          <dt>Today, exact</dt>
          <dd className="tabular" title={formatHMS(f.exactSecs)}>
            {formatDuration(wholeMinutes(f.exactSecs))}
            {f.thinkingSecs > 0 && <span className="muted ticker-sub"> includes {formatDuration(f.thinkingSecs)} thinking</span>}
          </dd>
        </div>
        <div>
          <dt>Today, billable{inc ? ` (${inc})` : ''}</dt>
          <dd className="tabular">
            {formatDuration(wholeMinutes(f.billableSecs))}
            {f.pauseSecs > 0 && <span className="muted ticker-sub"> includes {formatDuration(f.pauseSecs)} billable pauses</span>}
          </dd>
        </div>
        {rated && (
          <div>
            <dt>Billable now{inc ? ' (changes in steps)' : ''}</dt>
            <dd className="tabular" data-testid="billable-now">
              {amountText(f.billableNumerators, hide) || '—'}
            </dd>
          </div>
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
