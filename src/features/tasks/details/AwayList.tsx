// "Time away": time the app found you away while a segment ran, so a decision can be changed later.
import { useId, useState } from 'react';

import { useAppState } from '../../../app/store';
import { useReadOnly } from '../../../app/useReadOnly';
import { formatDuration } from '../../../components/format';
import { Badge, Button } from '../../../components/ui';
import { api } from '../../../lib/api';
import { parseIso } from '../../../lib/tz';
import { gapTitle, gapWord } from '../../away/awayLogic';
import type { GapDecision, IdleGap, Task } from '../../../lib/types';
import { attempt, sentence } from './attempt';
import { BILLED_REASON } from './CorrectionsList';
import { dayText, timesText } from './derive';

const CHOICES: { decision: Exclude<GapDecision, 'pending'>; label: string; done: string; effect: string }[] = [
  { decision: 'keep', label: 'Keep', done: 'Kept', effect: 'Counts as work.' },
  { decision: 'drop', label: 'Drop', done: 'Dropped', effect: 'Does not count.' },
  { decision: 'thinking', label: 'Mark as thinking', done: 'Marked as thinking', effect: 'Counts as thinking time, in Exact and in Billable.' },
];

const STATE: Record<GapDecision, { text: string; tone: 'warning' | 'success' | 'neutral' | 'accent' }> = {
  pending: { text: 'Waiting for your decision', tone: 'warning' },
  keep: { text: 'Kept', tone: 'success' },
  drop: { text: 'Dropped', tone: 'neutral' },
  thinking: { text: 'Thinking time', tone: 'accent' },
};

export function AwayList({ task }: { task: Task }) {
  const { snapshot, zones } = useAppState();
  const ro = useReadOnly();
  const zone = zones.active;
  const gaps = snapshot.gaps.filter((g) => g.taskId === task.id).sort((a, b) => (a.start < b.start ? 1 : a.start > b.start ? -1 : 0));
  const billedSegments = new Set(snapshot.rawSegments.filter((s) => s.billed).map((s) => s.id));
  const [notice, setNotice] = useState<string | null>(null);

  return (
    <div className="details-stack">
      {task.unconfirmedSecs > 0 && (
        <div className="details-warning" role="note">
          <p>
            <strong>Unconfirmed: not counted until you confirm.</strong> <span className="tabular">{formatDuration(task.unconfirmedSecs)}</span> of time away on this task is waiting for a decision.
          </p>
        </div>
      )}
      <p className="muted details-lead">Decide what time away means. You can change a decision later; the change is written to the history.</p>
      {ro.readOnly && (
        <p className="details-note" role="status">
          {ro.why}
        </p>
      )}
      <div aria-live="polite" className="details-live">
        {notice && <p className="details-success">{notice}</p>}
      </div>
      {gaps.length === 0 && <p className="muted">No time away has been found on this task.</p>}
      {gaps.length > 0 && (
        <ul className="away-list" aria-label="Time away">
          {gaps.map((g) => (
            <AwayItem key={g.id} gap={g} zone={zone} billed={billedSegments.has(g.segmentId)} onNotice={setNotice} />
          ))}
        </ul>
      )}
    </div>
  );
}

function AwayItem({ gap, zone, billed, onNotice }: { gap: IdleGap; zone: string; billed: boolean; onNotice: (t: string | null) => void }) {
  const { adopt } = useAppState();
  const ro = useReadOnly();
  const textId = useId();
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const span = { start: parseIso(gap.start), end: parseIso(gap.end) };
  const state = STATE[gap.decision];

  const decide = async (decision: Exclude<GapDecision, 'pending'>, done: string) => {
    setBusy(true);
    const r = await attempt(() => api.decideGap(gap.id, decision));
    setBusy(false);
    if (!r.ok) {
      setProblem(sentence(r.error.message));
      return;
    }
    setProblem(null);
    adopt(r.value);
    onNotice(`${done}: ${timesText(span, zone)} (${formatDuration(span.end - span.start)}).`);
  };

  return (
    <li className="away-row" data-gap-id={gap.id} data-decision={gap.decision}>
      <div className="away-head" id={textId}>
        <strong>{dayText(span, zone)}</strong>
        <span className="tabular">{timesText(span, zone)}</span>
        <span className="muted tabular">{formatDuration(span.end - span.start)}</span>
        <Badge title={gapTitle(gap)}>{gapWord(gap)}</Badge>
        <Badge tone={state.tone}>{state.text}</Badge>
      </div>
      {billed ? (
        <p className="details-note">{BILLED_REASON}.</p>
      ) : (
        <div className="inline-actions" role="group" aria-label={`Decision for ${timesText(span, zone)}`}>
          {CHOICES.map((c) => (
            <Button key={c.decision} small variant={gap.decision === c.decision ? 'primary' : 'secondary'} disabled={busy || gap.decision === c.decision || ro.readOnly} aria-describedby={textId} title={ro.readOnly ? (ro.why ?? undefined) : c.effect} onClick={() => void decide(c.decision, c.done)}>
              {c.label}
            </Button>
          ))}
        </div>
      )}
      {problem && (
        <p className="field-error" role="alert">
          {problem}
        </p>
      )}
    </li>
  );
}
