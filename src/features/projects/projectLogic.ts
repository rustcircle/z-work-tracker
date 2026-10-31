// Pure rules for the Projects tab: price parsing, unique names, and rate history.
import { money } from '../../lib/billing';
import { parseIso } from '../../lib/tz';
import type { Currency, Project, RateVersion } from '../../lib/types';

export type PriceResult = { ok: true; cents: number | null } | { ok: false; error: string };

/** Blank means "no rate", which is different from 0. Two decimals at most; 0 to 10000.00. */
export function parsePrice(text: string): PriceResult {
  const t = text.trim().replace(/^[€$]/, '').trim();
  if (t === '') return { ok: true, cents: null };
  if (!/^\d{1,5}([.,]\d{0,2})?$/.test(t)) return { ok: false, error: 'Enter a price like 90 or 90.50.' };
  const [whole = '0', frac = ''] = t.replace(',', '.').split('.');
  const cents = Number(whole) * 100 + Number(frac.padEnd(2, '0'));
  if (cents > 1_000_000) return { ok: false, error: 'The price per hour can be at most 10000.00.' };
  return { ok: true, cents };
}

export function centsToInput(cents: number | null): string {
  if (cents === null) return '';
  return cents % 100 === 0 ? String(cents / 100) : (cents / 100).toFixed(2);
}

export function validateProjectName(name: string, projects: readonly Project[], exceptId: string | null): string | null {
  const n = name.trim();
  if (n === '') return 'Enter a project name.';
  if (projects.some((p) => p.id !== exceptId && p.name.trim().toLowerCase() === n.toLowerCase())) return `A project named “${n}” already exists.`;
  return null;
}

export function parseBudget(text: string): { ok: true; hours: number | null } | { ok: false; error: string } {
  const t = text.trim();
  if (t === '') return { ok: true, hours: null };
  const n = Number(t.replace(',', '.'));
  if (!Number.isFinite(n) || n < 0 || n > 100_000) return { ok: false, error: 'Enter hours as a number, like 40.' };
  return { ok: true, hours: n };
}

/** Versions of a project's rate, newest first. */
export function rateHistory(rates: readonly RateVersion[], projectId: string): RateVersion[] {
  return rates.filter((r) => r.projectId === projectId && !r.deleted).sort((a, b) => parseIso(b.effectiveFrom) - parseIso(a.effectiveFrom));
}

/** The version in force at `sec`, or null when none has started. */
export function rateAt(rates: readonly RateVersion[], projectId: string, sec: number): RateVersion | null {
  return rateHistory(rates, projectId).find((r) => parseIso(r.effectiveFrom) <= sec) ?? null;
}

const isCurrency = (c: string): c is Currency => c === 'EUR' || c === 'USD';

/** "€60.00/h", or "No rate set". */
export function rateText(r: RateVersion | null, masked: string | null = null): string {
  if (!r || r.rateCents === null || !isCurrency(r.currency)) return 'No rate set';
  return masked ? `${masked}/h` : `${money(r.currency, r.rateCents)}/h`;
}

/** The backend's limit for a fixed fee: 0 to 1,000,000,000,000 cents. */
export const MAX_FEE_CENTS = 1_000_000_000_000;

export type FeeResult = { ok: true; cents: number } | { ok: false; error: string };

/** A fixed fee is required (unlike a price per hour), with two decimals at most. 0 is allowed. */
export function parseFee(text: string): FeeResult {
  const t = text.trim().replace(/^[€$]/, '').trim();
  if (t === '') return { ok: false, error: 'Enter the fixed fee, like 1000 or 1000.50.' };
  if (!/^\d{1,11}([.,]\d{0,2})?$/.test(t)) return { ok: false, error: 'Enter the fee as a number like 1000 or 1000.50.' };
  const [whole = '0', frac = ''] = t.replace(',', '.').split('.');
  const cents = Number(whole) * 100 + Number(frac.padEnd(2, '0'));
  if (cents > MAX_FEE_CENTS) return { ok: false, error: 'The fee can be at most 10,000,000,000.00.' };
  return { ok: true, cents };
}

/** "Fixed fee €1,000.00", or masked. */
export function feeText(p: Pick<Project, 'fixedFeeCents' | 'feeCurrency'>, masked: string | null = null): string {
  if (p.fixedFeeCents === null || p.feeCurrency === null) return 'Fixed fee not set';
  return `Fixed fee ${masked ?? money(p.feeCurrency, p.fixedFeeCents)}`;
}

/** "Effective hourly rate €52.17/h", or null when no time is logged yet. */
export function effectiveRateText(p: Pick<Project, 'feeCurrency' | 'figures'>, masked: string | null = null): string | null {
  const cents = p.figures.effectiveHourlyCents;
  if (cents === null || p.feeCurrency === null) return null;
  return `Effective hourly rate ${masked ?? money(p.feeCurrency, cents)}/h`;
}

/** What the budget bar says in words, so the state never rests on colour: "80% warning", "100% over". */
export const BUDGET_LEVEL_TEXT = { 0: '', 80: '80% warning', 100: '100% over' } as const;

export const NEEDS_TARGET_RATE_TEXT = 'A fixed fee needs a price per hour to measure your time against it';
