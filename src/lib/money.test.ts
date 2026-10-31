// The formatter behind `money` is reused for speed. Its text must be exactly what it was built to replace.
import { describe, expect, it } from 'vitest';

import { money } from './billing';

function before(currency: 'EUR' | 'USD', cents: number): string {
  const symbol = currency === 'EUR' ? '€' : '$';
  const whole = Math.floor(cents / 100);
  const frac = cents - whole * 100;
  return `${symbol}${whole.toLocaleString('en-US')}.${String(frac).padStart(2, '0')}`;
}

describe('money', () => {
  it('prints what toLocaleString printed, at every size and sign', () => {
    const values = [0, -0, 1, 5, 99, 100, 101, 999, 1000, 99_999, 100_000, 123_456_789, 2 ** 40, Number.MAX_SAFE_INTEGER];
    for (const v of values) {
      for (const cents of [v, -v, v + 1, -v - 1]) {
        expect(money('EUR', cents)).toBe(before('EUR', cents));
        expect(money('USD', cents)).toBe(before('USD', cents));
      }
    }
    let x = 7;
    for (let i = 0; i < 20_000; i += 1) {
      x = (x * 1103515245 + 12345) % 2147483648;
      const cents = (x % 2 ? 1 : -1) * (x % 10 ** ((i % 12) + 1));
      expect(money('EUR', cents)).toBe(before('EUR', cents));
    }
  });
});
