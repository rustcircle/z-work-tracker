// Phase 2 glossary entries: worked, thinking, unconfirmed and billable pause time, and subtask time.
import { g, type GlossaryEntry } from './glossaryBase';

export const GLOSSARY_P2_TIME: readonly GlossaryEntry[] = [
  g('pauses.billable', 'Billable pause time', 'Time pieces', 'Billable',
    'Time between two sessions of one task that you marked as still working, for example a wait for the client. It counts in Billable time, in earnings and in the rounding adjustment, and it is reported on its own. It is not worked time: Exact time, sessions, focus, volume, the time-of-day charts and shift figures leave it out. In the focus metrics the gap stays a pause, so a billable pause changes neither the pause count nor the focus ratio. It is rounded together with the task\'s Exact time of that day, once per task per day. Shown only while Billable is available, so not under a band or shift filter.',
    'Billable(task, day) = round(Exact + billable pause time); billable pause time = sum of the pause pieces'),
  g('time.thinking', 'Thinking time', 'Time pieces', 'Exact',
    'Time away (sleep or idle) inside a running session that you kept and marked as thinking. It is worked time: it is in Exact, in Billable and in the volume and time-of-day charts, and it is also reported on its own so you can see how much of the total it is. Away time you dropped is in no total, and away time you have not decided on yet is Unconfirmed time.',
    'thinking time = sum of the thinking pieces; included in Exact and in Billable'),
  g('time.unconfirmed', 'Unconfirmed time', 'Time pieces', 'Exact',
    'Time away that was detected while a task ran and that you have not decided on yet (Keep, Drop or Mark as thinking). It is in no piece of time, so it counts nowhere: not in Exact, not in Billable, not in earnings, not in sessions or any chart, until you confirm it. The Analysis figure adds up the unconfirmed stretches that overlap the period, for the tasks that pass the project, task and tag filters, and is hidden while a band or shift filter is on.',
    'unconfirmed time = sum of the pending away stretches overlapping the period; counted in no other total'),
  g('subtasks.time', 'Subtask time', 'Time pieces', 'Exact',
    'The time tracked on each task-list item of a task. A piece of a session belongs to the item that was active when it was recorded; time recorded while no item was active is the time with no subtask. The items plus the time with no subtask add up to the task\'s time (work and thinking; billable pauses belong to no item). Switching the active item while a task runs splits the session at that moment, but the Analysis session figures still count it as one session. A warm copy keeps the item text, unticked and without time.',
    'task time = sum of the item times + time with no subtask'),
];
