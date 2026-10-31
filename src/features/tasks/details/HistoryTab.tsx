// "History": what changed on this task's time, newest first.
import { useMemo } from 'react';

import { useAppState } from '../../../app/store';
import type { Task } from '../../../lib/types';
import { AuditList, useAudit } from './AuditList';
import { derivePauses, taskAudit } from './derive';

export function HistoryTab({ task }: { task: Task }) {
  const { snapshot } = useAppState();
  const { entries, error } = useAudit(null);
  const spans = useMemo(() => derivePauses(snapshot.rawSegments, task), [snapshot.rawSegments, task]);
  const mine = useMemo(() => (entries ? taskAudit(entries, snapshot, task.id, spans) : null), [entries, snapshot, task.id, spans]);
  return (
    <div className="details-stack">
      <p className="muted details-lead">Every change to this task&apos;s time: hand entries, corrections, voids, time away decisions and billed pauses. The full log for all tasks is in Settings.</p>
      <AuditList entries={mine} error={error} label="History of this task" />
    </div>
  );
}
