// The demo seed (src/mocks/demoSeed.ts) is hand-computable: the figures here are the ones the
// end-to-end test checks on screen. See the derivation in the comments.
import { describe, expect, it } from 'vitest';

import { demoNowSec, demoState } from '../../mocks/demoSeed';
import { handle } from '../../mocks/ipcMock';
import type { Snapshot } from '../../lib/types';
import { analyze } from './metrics';
import { params } from './testkit';

const snapshot = handle(demoState(), 'get_snapshot', {}) as Snapshot;
const now = demoNowSec();
const run = (zone: string, range: Parameters<typeof params>[1], over = {}) => analyze(snapshot, params(zone, range, over), now, 'billable');
const WEEK = { kind: 'week', anchor: '2026-03-12' } as const;

describe('demo seed, Lisbon (UTC+0 in March), week of 9 March', () => {
  // Per day: a 09:00-11:20 (8400) + a 11:35-12:50 (4500) + b 14:00-16:30 (9000) = 21900;
  // 11 March adds Email 17:00-17:20 (1200) and Logo 22:30-24:00 (5400); 12 March has Logo 00:00-00:40
  // (2400), 09:05-10:30 (5100) and the running 14:00 -> 15:20 (4800).
  const m = run('Europe/Lisbon', WEEK, { compare: true });

  it('exact and billable totals', () => {
    expect(m.volume.exact).toBe(21900 + 21900 + (21900 + 1200 + 5400) + (2400 + 5100 + 4800));
    expect(m.volume.exact).toBe(84600); // 23h 30m
    // Billable rows (15 min up): Mar 9 13500 + 9000, Mar 10 13500 + 9000, Mar 11 13500 + 9000 + 1800 + 5400, Mar 12 12600.
    expect(m.volume.billable).toBe(22500 + 22500 + 29700 + 12600);
    expect(m.volume.activeDays).toBe(4);
    expect(m.focus.sessions).toBe(13);
    expect(m.liveCount).toBe(1);
  });

  it('day, project and band figures', () => {
    expect(m.series.points.map((p) => p.exact)).toEqual([21900, 21900, 28500, 12300, 0, 0, 0]);
    const by = Object.fromEntries(m.projects.map((p) => [p.id, p]));
    // Brand refresh: Mar 9 logo 12900 + guide 9000, Mar 11 guide 12900 + logo 5400, Mar 12 logo 12300.
    expect(by['p-brand']?.exact).toBe(12900 + 9000 + 12900 + 5400 + 12300);
    expect(by['p-web']?.exact).toBe(12900 + 9000);
    expect(by['p-pack']?.exact).toBe(9000);
    expect(by['p-admin']?.exact).toBe(1200);
    expect(m.time.bands.reduce((n, b) => n + b.secs, 0)).toBe(84600);
  });

  it('earnings use the rate in force: Brand refresh moved to $90/h on 9 March', () => {
    // Brand refresh billable seconds: Mar 9 logo 13500 + guide 9000, Mar 11 guide 13500 + logo 5400, Mar 12 logo 12600 = 54000, all at $90.
    expect(m.money.numerators.USD).toBe(9000 * 54000);
    // Website: Mar 10 home 13500 + Mar 11 home 9000 = 22500 s at EUR 60.
    expect(m.money.numerators.EUR).toBe(6000 * 22500);
  });

  it('month and day views', () => {
    expect(run('Europe/Lisbon', { kind: 'month', anchor: '2026-03-12' }).volume.exact).toBe(208500);
    const day = run('Europe/Lisbon', { kind: 'day', anchor: '2026-03-12' });
    expect(day.volume.exact).toBe(12300);
    expect(day.volume.billable).toBe(12600);
  });

  it('exact totals are the same in every zone; billable days can differ', () => {
    const ny = run('America/New_York', WEEK);
    expect(ny.volume.exact).toBeGreaterThan(0);
    const wide = (z: string) => run(z, { kind: 'custom', anchor: '2026-03-01', from: '2026-03-01', to: '2026-03-31' }).volume.exact;
    expect(wide('America/New_York')).toBe(wide('Europe/Lisbon'));
    expect(wide('Asia/Tokyo')).toBe(wide('UTC'));
  });
});
