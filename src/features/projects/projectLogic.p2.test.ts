import { describe, expect, it } from 'vitest';

import { fullProject } from '../../mocks/factories';
import { BUDGET_LEVEL_TEXT, MAX_FEE_CENTS, NEEDS_TARGET_RATE_TEXT, effectiveRateText, feeText, parseFee } from './projectLogic';

describe('parseFee', () => {
  it('reads whole and decimal fees to exact cents, with a currency sign or a comma', () => {
    expect(parseFee('1000')).toEqual({ ok: true, cents: 100_000 });
    expect(parseFee('1000.5')).toEqual({ ok: true, cents: 100_050 });
    expect(parseFee('12,34')).toEqual({ ok: true, cents: 1234 });
    expect(parseFee('€ 60')).toEqual({ ok: true, cents: 6000 });
    expect(parseFee('0')).toEqual({ ok: true, cents: 0 });
    expect(parseFee('0.01')).toEqual({ ok: true, cents: 1 });
  });

  it('the fee is required, unlike a price per hour', () => {
    expect(parseFee('')).toMatchObject({ ok: false });
    expect(parseFee('   ')).toMatchObject({ ok: false });
  });

  it('accepts exactly the backend range, 0 to 1,000,000,000,000 cents', () => {
    expect(MAX_FEE_CENTS).toBe(1_000_000_000_000);
    expect(parseFee('10000000000')).toEqual({ ok: true, cents: 1_000_000_000_000 });
    expect(parseFee('10000000000.01')).toMatchObject({ ok: false });
    expect(parseFee('99999999999')).toMatchObject({ ok: false });
    expect(parseFee('999999999999')).toMatchObject({ ok: false });
  });

  it('rejects text, signs, exponents and a third decimal', () => {
    for (const bad of ['abc', '-5', '+5', '1e3', '1.234', '1 000', '1.2.3', '.5', '€']) expect(parseFee(bad).ok, bad).toBe(false);
  });
});

describe('fee and effective rate text', () => {
  const p = fullProject({ id: 'p', billingType: 'fixedFee', fixedFeeCents: 100_000, feeCurrency: 'EUR' });

  it('prints the fee, or masks it', () => {
    expect(feeText(p)).toBe('Fixed fee €1,000.00');
    expect(feeText(p, '••••')).toBe('Fixed fee ••••');
    expect(feeText({ fixedFeeCents: null, feeCurrency: null })).toBe('Fixed fee not set');
    expect(feeText({ fixedFeeCents: 5, feeCurrency: 'USD' })).toBe('Fixed fee $0.05');
  });

  it('prints the effective hourly rate once there is time, or masks it', () => {
    const base = fullProject({ id: 'p', feeCurrency: 'EUR' });
    expect(effectiveRateText(base)).toBeNull();
    const withTime = { ...base, figures: { ...base.figures, effectiveHourlyCents: 5217 } };
    expect(effectiveRateText(withTime)).toBe('Effective hourly rate €52.17/h');
    expect(effectiveRateText(withTime, '••••')).toBe('Effective hourly rate ••••/h');
    expect(effectiveRateText({ ...withTime, feeCurrency: null })).toBeNull();
  });

  it('budget words are the ones the brief names', () => {
    expect(BUDGET_LEVEL_TEXT[80]).toBe('80% warning');
    expect(BUDGET_LEVEL_TEXT[100]).toBe('100% over');
    expect(BUDGET_LEVEL_TEXT[0]).toBe('');
    expect(NEEDS_TARGET_RATE_TEXT).toBe('A fixed fee needs a price per hour to measure your time against it');
  });
});
