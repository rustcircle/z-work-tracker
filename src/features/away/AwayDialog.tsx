// Time away: a dialog on return that asks about each stretch the computer was idle or asleep, and a
// banner that stays until every one is answered. Unanswered time counts nowhere.
import { useMemo, useState } from 'react';

import { useApp } from '../../app/store';
import { IconWarn } from '../../components/icons';
import { useToast } from '../../components/Toasts';
import { Badge, Button, Modal, ProjectChip } from '../../components/ui';
import { api } from '../../lib/api';
import { formatDuration } from '../../components/format';
import { cityOf, dayOf, parseIso } from '../../lib/tz';
import type { GapDecision, IdleGap, Project, Task } from '../../lib/types';
import { rangeText } from '../timeline/DayCard';
import { UNCONFIRMED, gapSecs, gapWord, lengthText, pendingGaps, taskNames, totalSecs } from './awayLogic';
import { getAwayRequests, openAway, useAwayRequests } from './awayStore';
import './away.css';

interface Choice {
  decision: GapDecision;
  label: string;
  all: string;
  done: string;
}

const CHOICES: readonly Choice[] = [
  { decision: 'keep', label: 'Keep', all: 'Keep all', done: 'kept as work' },
  { decision: 'drop', label: 'Drop', all: 'Drop all', done: 'dropped' },
  { decision: 'thinking', label: 'Mark as thinking', all: 'Mark all as thinking', done: 'marked as thinking' },
];

const errorText = (e: unknown): string => (e && typeof e === 'object' && 'message' in e ? String((e as { message: unknown }).message) : String(e));

function GapRow({ gap, task, project, zone, today, busy, onDecide }: { gap: IdleGap; task: Task | undefined; project: Project | undefined; zone: string; today: string; busy: boolean; onDecide: (g: IdleGap, c: Choice) => void }) {
  const name = task?.name ?? 'Unknown task';
  const when = rangeText(parseIso(gap.start), parseIso(gap.end), zone, today);
  return (
    <li className="away-gap" data-testid="away-gap" data-gap={gap.id}>
      <div className="away-gap-head">
        <strong>{name}</strong>
        {project && <ProjectChip name={project.name} color={project.color} archived={project.archived} />}
        <Badge tone="warning" title={gap.kind === 'sleep' ? 'The computer was asleep' : 'No keyboard or mouse activity'}>
          {gapWord(gap)}
        </Badge>
      </div>
      <p className="away-gap-time tabular">
        {when} {cityOf(zone)} time, {lengthText(gap)} away
      </p>
      <div className="away-gap-actions" role="group" aria-label={`What to do with the ${lengthText(gap)} away from ${name}`}>
        {CHOICES.map((c) => (
          <Button key={c.decision} small disabled={busy} aria-label={`${c.label}: ${name}, ${when}`} onClick={() => onDecide(gap, c)}>
            {c.label}
          </Button>
        ))}
      </div>
    </li>
  );
}

/**
 * Opens by itself when time away is waiting that it has not asked about yet (also at start-up), and
 * whenever the banner or a day card asks. Dismissing it only hides it.
 */
export function AwayDialog() {
  const { snapshot, adopt, zones, nowSec } = useApp();
  const toast = useToast();
  const requests = useAwayRequests();
  const [handled, setHandled] = useState(getAwayRequests);
  const [asked, setAsked] = useState<ReadonlySet<string>>(new Set());
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const pending = useMemo(() => pendingGaps(snapshot.gaps), [snapshot.gaps]);
  const tasks = useMemo(() => new Map(snapshot.tasks.map((t) => [t.id, t])), [snapshot.tasks]);
  const projects = useMemo(() => new Map(snapshot.projects.map((p) => [p.id, p])), [snapshot.projects]);

  // Adjusting state while rendering: a manual request, or a pending id never asked about, opens it.
  if (requests !== handled) {
    setHandled(requests);
    setOpen(true);
  }
  if (pending.some((g) => !asked.has(g.id))) {
    setAsked(new Set(pending.map((g) => g.id)));
    setOpen(true);
  }
  if (open && pending.length === 0) setOpen(false);

  const today = dayOf(nowSec, zones.active);

  const decideAll = async (list: readonly IdleGap[], c: Choice): Promise<void> => {
    setBusy(true);
    setError(null);
    let done = 0;
    let secs = 0;
    try {
      // One at a time: each answer is a change of its own, and the last reply is the newest snapshot.
      for (const g of list) {
        adopt(await api.decideGap(g.id, c.decision));
        done += 1;
        secs += gapSecs(g);
      }
    } catch (e) {
      setError(`${errorText(e)}${done > 0 ? ` (${done} of ${list.length} answered)` : ''}`);
    } finally {
      setBusy(false);
    }
    if (done > 0) toast.push(`${formatDuration(secs)} of time away ${c.done}.`);
  };

  return (
    <Modal
      open={open && pending.length > 0}
      title="You were away. What should happen to that time?"
      wide
      onClose={() => setOpen(false)}
      footer={
        <Button data-autofocus onClick={() => setOpen(false)}>
          Decide later
        </Button>
      }
    >
      <p>
        <strong>{UNCONFIRMED}.</strong> A reminder stays at the top until every stretch is answered. You can change an answer later from the task's details.
      </p>
      <dl className="away-help">
        <dt>Keep</dt>
        <dd>counts as work time.</dd>
        <dt>Drop</dt>
        <dd>removes it. It counts nowhere.</dd>
        <dt>Mark as thinking</dt>
        <dd>counts in Exact and Billable, and is reported as thinking time.</dd>
      </dl>
      <ul className="away-list" aria-label="Time away waiting for an answer">
        {pending.map((g) => (
          <GapRow key={g.id} gap={g} task={tasks.get(g.taskId)} project={projects.get(tasks.get(g.taskId)?.projectId ?? '')} zone={zones.active} today={today} busy={busy} onDecide={(gap, c) => void decideAll([gap], c)} />
        ))}
      </ul>
      {pending.length > 1 && (
        <div className="away-all" role="group" aria-label={`Apply one answer to all ${pending.length} stretches`}>
          <strong>Apply to all {pending.length}:</strong>
          {CHOICES.map((c) => (
            <Button key={c.decision} disabled={busy} onClick={() => void decideAll(pending, c)}>
              {c.all}
            </Button>
          ))}
        </div>
      )}
      <div aria-live="polite">{error && <p className="away-error" role="alert">{error}</p>}</div>
    </Modal>
  );
}

/** Stays at the top while any time away is unanswered, with a way back into the dialog. */
export function AwayBanner() {
  const { snapshot } = useApp();
  const pending = useMemo(() => pendingGaps(snapshot.gaps), [snapshot.gaps]);
  const tasks = useMemo(() => new Map(snapshot.tasks.map((t) => [t.id, t])), [snapshot.tasks]);
  if (pending.length === 0) return null;
  return (
    <div className="banner banner-warning banner-away" role="status" data-testid="away-banner">
      <IconWarn />
      <span>
        <strong>{UNCONFIRMED}.</strong> {formatDuration(totalSecs(pending))} of time away on {taskNames(pending, tasks)} is waiting for your answer.
      </span>
      <Button small onClick={openAway}>
        Review time away
      </Button>
    </div>
  );
}
