// Wording and plain-text forms of billing summaries. Pure, so the tab and its tests share one source.
// A summary is for the user's own guidance: never an invoice, never a tax document, and it has no tax,
// sent or paid status.
import { MASK, ROUNDED_ROWS_NOTE, money, rowsDifferFromTotal } from '../../lib/billing';
import type { Currency, Project, SummaryRow } from '../../lib/types';
import { dayLabel, formatDuration } from '../../components/format';

export const GUIDANCE = 'For your own guidance. Not an invoice, not a tax document.';

export type Cents = Partial<Record<Currency, number>>;

export const hasCents = (c: Cents): boolean => c.EUR !== undefined || c.USD !== undefined;

/** "€12.00 + $3.50", or the mask while earnings are hidden, or '' when there is no amount. */
export function centsText(c: Cents, hide: boolean): string {
  const parts = (['EUR', 'USD'] as const).filter((cur) => c[cur] !== undefined).map((cur) => money(cur, c[cur] as number));
  if (parts.length === 0) return '';
  return hide ? MASK : parts.join(' + ');
}

export const pauseNote = (pauseSecs: number): string => `includes ${formatDuration(pauseSecs)} billable pauses`;

export interface Figures {
  exactSecs: number;
  pauseSecs: number;
  billableSecs: number;
}

export function sumRows(rows: readonly SummaryRow[]): Figures {
  const out: Figures = { exactSecs: 0, pauseSecs: 0, billableSecs: 0 };
  for (const r of rows) {
    out.exactSecs += r.exactSecs;
    out.pauseSecs += r.pauseSecs;
    out.billableSecs += r.billableSecs;
  }
  return out;
}

/** Why a project shows no hourly amount, or null when it should have one. */
export type NoAmount = 'fixedFee' | 'notBillable' | null;

export function noAmountReason(project: Pick<Project, 'billable' | 'billingType'> | undefined): NoAmount {
  if (!project) return null;
  if (project.billingType === 'fixedFee') return 'fixedFee';
  if (!project.billable) return 'notBillable';
  return null;
}

export const FIXED_FEE_TEXT = 'Fixed fee: no hourly amount';

/** "€1,000.00", masked while earnings are hidden; '' when the project has no fee set. */
export function feeText(project: Pick<Project, 'fixedFeeCents' | 'feeCurrency'>, hide: boolean): string {
  if (project.fixedFeeCents === null || project.feeCurrency === null) return '';
  return hide ? MASK : money(project.feeCurrency, project.fixedFeeCents);
}

export interface SummaryTextInput {
  /** Set for a saved summary, e.g. `A-001`. */
  reference?: string;
  voided?: boolean;
  projectName: string;
  noAmount: NoAmount;
  fee: string;
  from: string;
  to: string;
  zone: string;
  rows: readonly SummaryRow[];
  totals: Cents;
  /** The user has Hide earnings on: the text carries no amounts. */
  hide: boolean;
  runningExcluded?: boolean;
}

/**
 * Plain text for the clipboard. Amounts are left out while earnings are hidden, so Copy cannot leak
 * what the screen masks.
 */
export function summaryText(i: SummaryTextInput): string {
  const lines: string[] = [GUIDANCE];
  if (i.reference) lines.push(`${i.reference} (${i.voided ? 'Voided' : 'Live'})`);
  lines.push(`Project: ${i.projectName}`);
  lines.push(`Period: ${dayLabel(i.from)} to ${dayLabel(i.to)} (${i.zone})`);
  lines.push('');
  const showMoney = !i.hide && i.noAmount === null;
  for (const r of i.rows) {
    const parts = [dayLabel(r.day), r.taskName, `exact ${formatDuration(r.exactSecs)}`, `billable ${formatDuration(r.billableSecs)}${r.pauseSecs > 0 ? ` (${pauseNote(r.pauseSecs)})` : ''}`];
    const amount = showMoney ? centsText(r.cents, false) : '';
    if (amount) parts.push(amount);
    lines.push(parts.join(' | '));
  }
  const f = sumRows(i.rows);
  const total = [`Total`, `exact ${formatDuration(f.exactSecs)}`, `billable ${formatDuration(f.billableSecs)}${f.pauseSecs > 0 ? ` (${pauseNote(f.pauseSecs)})` : ''}`];
  const amount = showMoney ? centsText(i.totals, false) : '';
  if (amount) total.push(amount);
  lines.push(total.join(' | '));
  if (showMoney && rowsDifferFromTotal(i.rows.map((r) => r.cents), i.totals)) lines.push(ROUNDED_ROWS_NOTE);
  if (i.noAmount === 'fixedFee') lines.push(`${FIXED_FEE_TEXT}.${i.fee && !i.hide ? ` Fee: ${i.fee}.` : ''}`);
  if (i.noAmount === 'notBillable') lines.push('Not a billable project: no amount.');
  if (i.hide && i.noAmount === null) lines.push('Amounts are left out because Hide earnings is on.');
  if (i.runningExcluded) lines.push('A running segment is not included.');
  return lines.join('\n');
}

export function periodText(from: string, to: string, zone: string): string {
  return from === to ? `${dayLabel(from)} (${zone})` : `${dayLabel(from)} to ${dayLabel(to)} (${zone})`;
}
