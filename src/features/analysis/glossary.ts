// The Metrics glossary. Every figure on the screen, in an insight and in the Excel sheets has an
// entry here, with its plain definition, its formula and whether it uses Exact or Billable time.
// Phase 2 entries live in the glossaryP2* files, one per area, so each can grow on its own.
import { g, type GlossaryBasis, type GlossaryEntry } from './glossaryBase';
import { GLOSSARY_P2_MONEY } from './glossaryP2Money';
import { GLOSSARY_P2_TAGS } from './glossaryP2Tags';
import { GLOSSARY_P2_TIME } from './glossaryP2Time';

export type { GlossaryBasis, GlossaryEntry };

export const GLOSSARY: readonly GlossaryEntry[] = [
  g('basis', 'Exact and Billable time', 'Basics', 'Neither',
    'Exact is the real logged time from the segments, to the second. Billable is the rounded time from your rounding rule (default 15 minutes, up), applied once per task per day in the zone shown, never per segment. Exact totals are the same in every zone; Billable can differ by zone because the day edges move. Continued tasks count as separate tasks: a task that continues an earlier one is rounded on its own, so a chain can round up more than once on the same day. Billable pauses (waits you marked as still working) count in Billable and never in Exact, and are rounded together with that day\'s Exact time; thinking time counts in both. Time away you have not confirmed counts in neither.',
    'Billable(task, day) = round(Exact(task, day) + billable pauses(task, day)); totals = sum of those rows'),
  g('filters.time', 'Band and shift filters', 'Basics', 'Exact',
    'A band or shift filter keeps only the time inside the chosen band or shift. A session that crosses the edge is cut at the edge, so session lengths in a filtered view describe the part inside the filter. Billable rounds whole task-days, so Billable, earnings and rounding figures are hidden while a band or shift filter is on.',
    'kept time = logged time within the band hours or the shift window'),

  g('volume.total', 'Total time', 'Volume', 'Follows the Basis switch',
    'Everything logged in the period, including the running task. Shown with both Exact and Billable; the Basis switch picks the one used for charts and comparisons. Billable includes billable pauses and Exact does not; thinking time is in both.',
    'sum of segment durations (Exact) or of task-day rows (Billable)'),
  g('volume.activeDays', 'Active days', 'Volume', 'Exact',
    'Days in the period, in the zone shown, with any logged time.', 'count of days with time > 0'),
  g('volume.avgActiveDay', 'Average per active day', 'Volume', 'Follows the Basis switch',
    'Total time divided by the days you actually logged time on.', 'total / active days'),
  g('volume.avgCalendarDay', 'Average per calendar day', 'Volume', 'Follows the Basis switch',
    'Total time divided by the days of the period that have started, today included. Future days are not counted.', 'total / elapsed days'),
  g('volume.perWeek', 'Average per week', 'Volume', 'Follows the Basis switch',
    'Total time divided by the elapsed weeks. Needs at least 7 elapsed days.', 'total / (elapsed days / 7)'),
  g('volume.delta', 'Change against the previous period', 'Volume', 'Follows the Basis switch',
    'Difference to the previous equivalent period (the week before, the month before, and so on; a custom range compares with the same number of days just before it). Percent change is empty when the previous value is zero.',
    'delta = value - previous; percent = delta / previous'),

  g('time.bands', 'Hours per band', 'Time of day', 'Exact',
    'Logged time by wall-clock band in the zone shown: Night 00-06, Morning 06-12, Afternoon 12-18, Evening 18-24. On a 23-hour or 25-hour day the band hours follow the real clock, so one band can be an hour shorter or longer.',
    'band share = band time / total time'),
  g('time.mostBand', 'Most and least active band', 'Time of day', 'Exact',
    'The band with the most and the least logged hours in the period. Ties go to the earlier band.', 'argmax and argmin of band time'),
  g('time.hours', 'Hour-of-day histogram', 'Time of day', 'Exact',
    'Logged time bucketed by wall-clock hour. When clocks go back, the repeated hour is one bucket and both passes land in it; when clocks go forward, the skipped hour stays empty for that day.',
    'bucket h = time logged while the wall clock reads h:00-h:59'),
  g('time.heat', 'Weekday by hour heatmap', 'Time of day', 'Exact',
    'The same hour buckets split by weekday. Darker cells hold more time. Repeated and skipped hours behave as in the hour histogram.', 'cell = time logged in that weekday and wall-clock hour'),
  g('time.weekdays', 'Weekday totals', 'Time of day', 'Exact',
    'Logged time per weekday, and the average per weekday occurrence that has started in the period.', 'average = weekday time / weekday occurrences so far'),
  g('time.mostWeekday', 'Most and least active weekday', 'Time of day', 'Exact',
    'The weekday with the most and the least logged time among weekdays that occur in the period.', 'argmax and argmin of weekday time'),
  g('time.calendar', 'Year calendar', 'Time of day', 'Exact',
    'One cell per day of the calendar year of the period\'s last day, shaded by logged time. It follows the project and task filters and the active zone.', 'cell = time logged that day'),

  g('projects.hours', 'Project hours', 'Projects', 'Follows the Basis switch',
    'Time per project. With Billable on, project totals come from the task-day rows so they add up to the Billable total.', 'sum of the project\'s rows (Billable) or segments (Exact)'),
  g('projects.share', 'Share of time', 'Projects', 'Follows the Basis switch',
    'Each part of the total for the period. The switch above the donut changes what the parts are: projects, tasks, subtasks (a task\'s time on no subtask is a part of its own) or tags. It starts on the level the filter leaves open (the projects, the tasks of the one project chosen, or the subtasks of the one task chosen), and a row names only what the filter leaves open. At the Tags level time counts once, under the exact combination of tags it counts under, such as "Design + Client", or under "No tag": the tags of its task, except that time on a subtask that has tags of its own counts under those, so one task can have a row for each set. The legend beside the donut writes every slice\'s hours and percentage as text, and the hours add up to the total in the centre. The percentages are whole numbers that always add up to 100, so some slices can differ by a point from plain rounding; a slice whose share rounds to 0 reads "<1%". With more than nine tasks, subtasks or combinations the top eight show and the rest are grouped as "Other (N tasks)", "Other (N subtasks)" or "Other (N combinations)"; View data lists every row. Under Billable a task\'s rounded time is shared among its subtasks in proportion to their exact time.',
    'slice time / total of the slices; minutes and percent shared out by the largest remainder'),
  g('projects.trend', 'Project trend', 'Projects', 'Follows the Basis switch',
    'Change in a project\'s time against the previous period, and its stacked share over time.', 'delta = project time - previous project time'),
  g('projects.tasks', 'Tasks per project and average per task', 'Projects', 'Follows the Basis switch',
    'Tasks with time in the period, and the project\'s time divided by that count.', 'average = project time / tasks with time'),

  g('tasks.completed', 'Completed tasks', 'Tasks', 'Neither', 'Tasks stopped in the period (stop time inside it). Drafts and paused tasks are not completed.', 'count of tasks with stop time in the period'),
  g('tasks.inProgress', 'Tasks in progress', 'Tasks', 'Neither', 'Running or paused tasks that have time logged in the period.', 'count of running or paused tasks with time in the period'),
  g('tasks.duration', 'Task duration', 'Tasks', 'Exact', 'Average, median and longest time logged on one task in the period.', 'mean, median and max of per-task time'),
  g('tasks.age', 'Calendar age of completed tasks', 'Tasks', 'Neither', 'Wall time from a completed task\'s first start to its stop, including every pause and idle day.', 'stop time - first start'),
  g('tasks.top', 'Top tasks', 'Tasks', 'Follows the Basis switch', 'The ten tasks with the most time in the period.', 'tasks sorted by time'),
  g('tasks.multiDay', 'Tasks spanning several days', 'Tasks', 'Neither', 'Tasks with time on two or more days of the period, in the zone shown.', 'count of tasks with rows on 2 or more days'),

  g('focus.sessions', 'Sessions', 'Focus', 'Exact', 'A session is one segment: one uninterrupted Start or Resume to Pause or Stop, cut to the period and to any filter. Switching the active subtask does not split it. Time you marked as thinking is a stretch of its own, and billable pauses are not sessions.', 'count of segments'),
  g('focus.avgSession', 'Session length', 'Focus', 'Exact', 'Average, median and longest session.', 'mean, median and max of segment durations'),
  g('focus.dist', 'Session-length distribution', 'Focus', 'Exact', 'How many sessions fall into each length range, stacked by project.', 'count of sessions per range'),
  g('focus.streak', 'Longest uninterrupted stretch', 'Focus', 'Exact', 'The longest run of logged time with no gap between sessions (sessions at most one second apart join up, even across tasks).', 'longest merged run of sessions'),
  g('focus.pausedTime', 'Paused time', 'Focus', 'Exact',
    'The gap between consecutive segments of one task, plus the last segment\'s end to the task\'s stop time, when the gap begins and ends on the same calendar day in the zone you are viewing. Gaps that cross midnight (overnight, weekend or multi-day breaks between sessions) are not pauses and are left out of every figure. A task that is still paused has an open gap, which is not counted. A pause belongs to the day it began. A billable pause stays a pause here: marking it billable changes Billable time, not the pause count or the focus ratio. Away time you dropped or have not confirmed also leaves a gap, so it shows as paused time; away time you marked as thinking does not.',
    'gap = next start - previous end, kept only when both fall on one calendar day'),
  g('focus.pauses', 'Pauses', 'Focus', 'Exact', 'Number, total and average length of same-day paused-time gaps that began in the period, and pauses per task with sessions in the period.', 'count, sum and mean of gaps'),
  g('focus.ratio', 'Focus ratio', 'Focus', 'Exact', 'Worked time as a share of worked plus paused time, where paused time is same-day pauses only (overnight and multi-day gaps are excluded). It measures logged time, not output.', 'worked / (worked + paused)'),
  g('focus.switches', 'Context switches', 'Focus', 'Exact', 'Within one day, a session on a different task from the one before it. Resuming the same task is not a switch.', 'count of consecutive sessions on different tasks, per day'),
  g('focus.fragmentation', 'Fragmentation', 'Focus', 'Exact', 'Share of logged time that sits in sessions shorter than 25 minutes.', 'time in sessions under 25 min / total'),

  g('consistency.streak', 'Day streak', 'Consistency', 'Exact', 'Consecutive calendar days with logged time, ending today (or at the period\'s last day). A day that has just started with nothing logged does not break the streak. Counted within the calendar year around the period.', 'length of the run of days with time > 0'),
  g('consistency.start', 'Typical start', 'Consistency', 'Exact', 'The median first start of the day, with the middle half (first to third quartile) as its variability. A session that began on a day belongs to it. Needs three days.', 'median and quartiles (linear interpolation) of daily first start'),
  g('consistency.finish', 'Typical finish', 'Consistency', 'Exact', 'The median end of the last session that began that day. A session running past midnight finishes after 24:00 on the day it began.', 'median and quartiles of daily last end'),
  g('consistency.span', 'Working span', 'Consistency', 'Exact', 'Time from the first start to the last end on a day, breaks included.', 'last end - first start'),
  g('consistency.regularity', 'Weekday regularity', 'Consistency', 'Exact', 'How even the weekday averages are: the standard deviation of the seven weekday averages divided by their mean. Lower is more even. Needs three weekdays with data.', 'standard deviation / mean of weekday averages'),
  g('consistency.overtime', 'Overtime', 'Consistency', 'Exact', 'Logged time beyond the scheduled time of a day. Scheduled time is the shift-scheduled hours when shifts exist, otherwise the daily target. Not shown when neither is set.', 'sum over days of max(0, logged - scheduled)'),

  g('goals.daily', 'Daily target', 'Goals', 'Exact', 'Logged time on the period\'s last elapsed day against the daily target, and how many elapsed days reached it. Hidden until a target is set.', 'attainment = logged / target'),
  g('goals.weekly', 'Weekly target', 'Goals', 'Exact', 'Logged time in the Monday-to-Sunday week of the period\'s last elapsed day against the weekly target. Hidden until a target is set.', 'attainment = logged / target'),
  g('goals.budget', 'Project budget burn', 'Goals', 'Exact', 'All-time logged (Exact) time on a project against its budget hours, ignoring the date range. The projected finish assumes the average pace of the last 28 days, today included. Budget used is the project\'s own status in Billable time with the 80% and 100% alerts.', 'finish = today + remaining / (time in last 28 days / 28)'),

  g('money.billable', 'Billable projects share', 'Money', 'Billable', 'Share of Billable time spent on projects marked billable.', 'time on billable projects / all Billable time'),
  g('money.earnings', 'Earnings', 'Money', 'Billable', 'Billable time multiplied by the rate in force when the time was logged, per currency. Currencies are never added together. Rounded to cents only at the total shown. A billable hourly project with no rate shows "No rate set", not zero. A fixed-fee project earns its fee instead: it has no hourly earnings here and shows its effective hourly rate.', 'sum of rate x Billable seconds / 3600 (hourly projects only)'),
  g('money.hourly', 'Effective hourly rate', 'Money', 'Billable', 'Earnings divided by the Exact hours that earned in that currency, so rounding up and billable pauses, which add earnings but no Exact hours, raise it above the nominal rate.', 'earnings / Exact hours with a rate'),
  g('money.rounding', 'Rounding adjustment', 'Money', 'Billable', 'Billable time minus Exact time, per period and project, and what that difference is worth. Billable pauses are Billable only, so they are included in the adjustment: it is the rounding plus the billable pauses, and Analysis says how much of it is pauses. Each task rounds separately per day, so a chain of continued tasks can round up more than once, and that shows up here as a larger adjustment.', 'Billable - Exact = rounding + billable pauses'),

  g('forecast.projected', 'Projection', 'Forecast', 'Follows the Basis switch', 'A projection, not a promise: the total so far extended linearly to the end of the period. Shown only for periods of 7 days or more that are under way, with at least two active days and 20% elapsed.', 'logged / elapsed fraction of the period'),

  g('shifts.scheduled', 'Scheduled hours', 'Shifts', 'Exact', 'Shift window length minus the break, for the part of each window already due (up to now) and inside the period. Overlapping shifts each count their own scheduled hours.', 'sum of (window - break) x due fraction'),
  g('shifts.attainment', 'Shift attainment', 'Shifts', 'Exact', 'Logged time inside shift windows against scheduled hours. Where windows overlap, each moment goes to the window that started earliest (ties by shift id), so worked time is never counted twice. Values above 100% are possible because breaks are inside the window.', 'worked in windows / scheduled'),
  g('shifts.outside', 'Outside any shift', 'Shifts', 'Exact', 'Logged time that falls in no shift window.', 'time in no window'),
  g('shifts.late', 'Start and finish against shift bounds', 'Shifts', 'Exact', 'For finished windows with work: how many started more than a minute after the shift start and how late on average, and how many finished more than a minute before the shift end and how early. Neutral figures, not scores.', 'first start - window start; window end - last end'),
  g('shifts.coverage', 'Coverage', 'Shifts', 'Exact', 'Share of the due window time (breaks included) that has any logged time. For a shift in the client\'s zone this is the coverage of the client-hours shift.', 'union of logged time in the window / due window length'),
  g('shifts.overtime', 'Overtime against shifts', 'Shifts', 'Exact', 'Logged time beyond the scheduled time of the day.', 'sum over days of max(0, logged - scheduled)'),
  g('shifts.byProject', 'Shift time by project', 'Shifts', 'Exact', 'Logged time inside each shift, split by project.', 'worked in the shift\'s windows per project'),

  g('zones.bands', 'Hours by band in two zones', 'Zones', 'Exact', 'The same logged time bucketed by band in My zone and in the client zone, side by side.', 'band time in each zone'),
  g('zones.overlap', 'Client working hours overlap', 'Zones', 'Exact', 'Logged time that falls inside the client\'s working hours (Settings, default 09:00-17:00) in the client\'s zone. Every day counts, weekends included, and hours that end before they start, such as 22:00-06:00, run overnight.', 'time inside client work hours / total'),
  g('zones.gap', 'Time gap between zones', 'Zones', 'Neither', 'The gap changes in weeks when the two zones switch daylight saving on different dates. Each stretch with a constant gap is listed.', 'offset(client) - offset(my zone)'),
  g('zones.markers', 'Clock changes', 'Zones', 'Neither', 'Dates in the period when a zone\'s clocks change. Zones without a change show none.', 'offset changes in the period'),

  ...GLOSSARY_P2_TIME,
  ...GLOSSARY_P2_MONEY,
  ...GLOSSARY_P2_TAGS,
];

const byId = new Map(GLOSSARY.map((e) => [e.id, e]));
export const glossaryEntry = (id: string): GlossaryEntry | undefined => byId.get(id);

export function searchGlossary(query: string): GlossaryEntry[] {
  const q = query.trim().toLowerCase();
  if (!q) return [...GLOSSARY];
  return GLOSSARY.filter((e) => `${e.name} ${e.family} ${e.definition} ${e.formula} ${e.basis}`.toLowerCase().includes(q));
}
