import { describe, expect, it } from 'vitest';

import { RateBook, ruleFor } from './billing';
import { parseIso } from './tz';
import type { RateVersion, RoundingVersion } from './types';


describe('versions saved for the same date', () => {
  const version = (id: string, at: string, minutes: number) =>
    ({ id, projectId: null, effectiveFrom: '2026-01-01', incrementMinutes: minutes, method: 'up', deleted: false, stamp: { at, by: 'd' } }) as RoundingVersion;
  it('the later save wins whatever the id, as in the Rust core', () => {
    const list = [version('z', '2026-01-01T00:00:00Z', 5), version('a', '2026-01-02T00:00:00Z', 30)];
    expect(ruleFor(list, 'p', '2026-02-01').incrementMinutes).toBe(30);
    expect(ruleFor([...list].reverse(), 'p', '2026-02-01').incrementMinutes).toBe(30);
  });
  it('a later rate saved for the same instant wins', () => {
    const rate = (id: string, at: string, rateCents: number) =>
      ({ id, projectId: 'p', effectiveFrom: '2026-01-01T00:00:00Z', rateCents, currency: 'EUR', deleted: false, stamp: { at, by: 'd' } }) as RateVersion;
    const book = new RateBook([{ id: 'p', billable: true }], [rate('z', '2026-01-01T00:00:00Z', 100), rate('a', '2026-01-02T00:00:00Z', 200)]);
    expect(book.at('p', parseIso('2026-02-01T00:00:00Z')).rateCents).toBe(200);
  });
});
