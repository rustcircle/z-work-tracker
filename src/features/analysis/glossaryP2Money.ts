// Phase 2 glossary entries: billable pauses in rounding, effective hourly rate on fixed fees, budget used, billed and unbilled.
import { g, type GlossaryEntry } from './glossaryBase';

export const GLOSSARY_P2_MONEY: readonly GlossaryEntry[] = [
  g('money.fixedFeeRate', 'Effective hourly rate on a fixed fee', 'Money', 'Billable',
    'For a fixed-fee project, the agreed fee divided by all the billable hours worked on it: what the job pays per hour, which falls as the hours go up. A fixed-fee project earns its fee, not an hourly rate, so it has no hourly earnings and never shows "No rate set". The billable hours include billable pauses and rounding and cover the whole life of the project, so the figure ignores the date range. It stays empty until the project has billable time. Hide earnings masks it.',
    'fee / (Billable seconds / 3600), rounded down to a cent'),
  g('budget.used', 'Budget used', 'Money', 'Billable',
    'How much of a project\'s budget is used, as a whole percent rounded down, so 79.9% is still 79%. With an hours budget it is Billable time (rounding and billable pauses included) against the budget hours. With a fixed fee it is the project\'s time valued at its own hourly rates against the fee, so a fixed fee needs a price per hour to measure against; without one the figure says so instead of showing a percent. 80% is a warning and 100% is over budget, and the level is written out as well as shown by colour and pattern. It covers the whole life of the project and ignores the date range. The Project budget burn chart is a different measure: it uses Exact time and the budget hours only.',
    'hours: floor(100 x Billable seconds / (budget hours x 3600)); fee: floor(100 x time value / fee); level = 100 from 100%, 80 from 80%, else 0'),
  g('billing.billedUnbilled', 'Billed and unbilled time', 'Money', 'Exact',
    'Time that is on a live billing summary (billed) and time that is not yet on one (unbilled), per task. A summary is for your own guidance, not an invoice. Billed plus unbilled is all the time counted for the task (work, thinking and billable pauses) in recorded seconds, before rounding. Voiding a summary returns its time to unbilled. Unconfirmed time is in neither.',
    'task time = billed + unbilled'),
];
