// UI review R14: the percent of a fixed fee that is used is money (time at the rates against the fee), so it
// hides with the fee when Hide earnings is on, as it does on the Projects tab. A percent of hours is not money.
import { clearMocks } from '@tauri-apps/api/mocks';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { MASK } from '../../lib/billing';
import { parseIso } from '../../lib/tz';
import type { Snapshot } from '../../lib/types';
import { boot, polyfillDom } from '../../components/testKit';
import { demoP2State } from '../../mocks/demoSeed';
import { buildInsights } from './insights';
import { analyze } from './metrics';
import { mkSnapshot, params } from './testkit';

beforeEach(polyfillDom);
afterEach(() => clearMocks());

const figures = (b: NonNullable<Snapshot['projects'][number]['figures']['budget']>) => ({ exactSecs: 0, pauseSecs: 0, billableSecs: 0, thinkingSecs: 0, effectiveHourlyCents: null, timeValueCents: {}, budget: b });

describe('R14: insights', () => {
  const now = '2026-03-12T12:00:00Z';
  const snap = mkSnapshot({
    now,
    projects: [
      { id: 'fee', name: 'Print run', billingType: 'fixedFee', fixedFeeCents: 100_000, feeCurrency: 'EUR', figures: figures({ basis: 'fee', percent: 86, level: 80, needsTargetRate: false }) },
      { id: 'hrs', name: 'Website', figures: figures({ basis: 'hours', percent: 91, level: 80, needsTargetRate: false }) },
    ],
    tasks: [{ id: 't1', projectId: 'fee' }],
    segs: [['t1', '2026-03-10T09:00:00Z', '2026-03-10T10:00:00Z']],
  });
  const m = analyze(snap, params('UTC', { kind: 'week', anchor: '2026-03-10' }), parseIso(now), 'exact');
  const texts = (hideEarnings: boolean): string[] => buildInsights(m, { hideEarnings, names: new Map() }).filter((i) => i.metrics.includes('budget.used')).map((i) => i.text);

  it('says the percent of the fee while earnings are shown', () => {
    expect(texts(false).join(' ')).toContain('Print run has used 86% of its fixed fee');
  });

  it('masks the percent of the fee but not the percent of hours while earnings are hidden', () => {
    const hidden = texts(true).join(' ');
    expect(hidden).toContain(`Print run has used ${MASK} of its fixed fee`);
    expect(hidden).not.toContain('86%');
    expect(hidden).toContain('Website has used 91% of its hours budget');
  });
});

describe('R14: the Analysis screen', () => {
  const heading = (name: string) => screen.getByRole('heading', { name });
  const cardOf = (name: string) => heading(name).closest('article') as HTMLElement;

  async function openAnalysis(user: ReturnType<typeof userEvent.setup>) {
    boot(demoP2State());
    await user.click(await screen.findByRole('tab', { name: 'Analysis' }));
    await screen.findByRole('heading', { name: 'Budget status' });
  }

  it('shows the percent of the fee while earnings are shown', async () => {
    const user = userEvent.setup();
    await openAnalysis(user);
    const budget = within(cardOf('Budget status'));
    expect(budget.getByText('86% used.')).toBeTruthy();
    expect(budget.getByRole('img', { name: /Print run \(fixed fee\): 86% of the fixed fee used/ })).toBeTruthy();
    expect(within(cardOf('Fixed-fee projects')).getByRole('row', { name: /Print run/ }).textContent).toContain('86%');
    expect(within(screen.getByRole('article', { name: 'Insights' })).getByText(/Print run \(fixed fee\) has used 86% of its fixed fee/)).toBeTruthy();
  });

  it('masks it in the budget status, the fixed-fee table and the insights when earnings are hidden, and keeps the percent of hours', async () => {
    const user = userEvent.setup();
    await openAnalysis(user);
    await user.click(screen.getByRole('button', { name: 'Hide earnings' }));
    await waitFor(() => expect(within(cardOf('Fixed-fee projects')).getByRole('row', { name: /Print run/ }).textContent).toContain(MASK));
    const budget = cardOf('Budget status');
    expect(budget.textContent).not.toContain('86%');
    expect(within(budget).queryByRole('img', { name: /Print run/ })).toBeNull();
    expect(within(cardOf('Fixed-fee projects')).getByRole('row', { name: /Print run/ }).textContent).not.toContain('86%');
    expect(within(screen.getByRole('article', { name: 'Insights' })).queryByText(/86%/)).toBeNull();
    // The level is still said in words, as on the Projects tab, and a budget in hours keeps its percent.
    expect(within(budget).getByTestId('budget-level-p-print').textContent).toContain('Warning: 80% reached');
    const hours = within(budget.querySelector('li[data-level="0"]') as HTMLElement);
    expect(hours.getByText(/\d+% used\./)).toBeTruthy();
  });
});
