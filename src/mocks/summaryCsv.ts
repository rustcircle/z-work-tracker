// The text of a billing summary's CSV file, for the mock. A port of `summary_csv` in summary.rs: with
// Hide earnings on there are no amount columns, and a voided summary says so in a Status row.
import { ROUNDED_ROWS_NOTE, rowsDifferFromTotal } from '../lib/billing';
import type { BillingSummary } from '../lib/types';

/** Prefixes an apostrophe when a spreadsheet could read the cell as a formula (csv.rs `neutralize`). */
function neutralize(cell: string): string {
  const first = cell.replace(/^[  ]+/, '').charAt(0);
  return first !== '' && '=+-@\t\r\n＝＋－＠'.includes(first) ? `'${cell}` : cell;
}

function quote(cell: string): string {
  return /[",;\t\n\r]/.test(cell) ? `"${cell.replace(/"/g, '""')}"` : cell;
}

const hours = (secs: number): string => (secs / 3600).toFixed(2);
const amount = (cents: number): string => (cents / 100).toFixed(2);

export function summaryCsv(b: BillingSummary, projectName: string, hideEarnings: boolean): string {
  const lines: string[] = [];
  const line = (cells: readonly string[]): void => {
    lines.push(cells.map(quote).join(','));
  };
  line(['For your own guidance. Not an invoice, not a tax document.']);
  if (hideEarnings) line(['Amounts are left out because Hide earnings is on.']);
  if (b.voided) line(['Status', 'Voided']);
  line(['Reference', neutralize(b.reference)]);
  line(['Project', neutralize(projectName)]);
  line(['Period', neutralize(`${b.from} to ${b.to} (${b.zone})`)]);
  const currencies = hideEarnings ? [] : Object.keys(b.totals).sort();
  line(['Day', 'Task', 'Exact hours', 'Billable pause hours', 'Billable hours', ...currencies.map(neutralize)]);
  for (const r of b.rows) {
    line([neutralize(r.day), neutralize(r.taskName), hours(r.exactSecs), hours(r.pauseSecs), hours(r.billableSecs), ...currencies.map((c) => amount((r.cents as Record<string, number | undefined>)[c] ?? 0))]);
  }
  const sum = (pick: (r: BillingSummary['rows'][number]) => number): number => b.rows.reduce((n, r) => n + pick(r), 0);
  line(['Total', '', hours(sum((r) => r.exactSecs)), hours(sum((r) => r.pauseSecs)), hours(sum((r) => r.billableSecs)), ...currencies.map((c) => amount((b.totals as Record<string, number | undefined>)[c] ?? 0))]);
  if (currencies.length > 0 && rowsDifferFromTotal(b.rows.map((r) => r.cents), b.totals)) line([ROUNDED_ROWS_NOTE]);
  return `${lines.join('\r\n')}\r\n`;
}
