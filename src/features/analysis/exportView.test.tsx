// UI review R1: the Excel analytics sheets follow the Analysis tab, so a filter set there must be said in the
// file and in the dialog, and must stop applying once the tab is left, when nobody can see it any more.
import { emit } from '@tauri-apps/api/event';
import { clearMocks } from '@tauri-apps/api/mocks';
import { act, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { boot, polyfillDom } from '../../components/testKit';
import { parseIso } from '../../lib/tz';
import { demoState } from '../../mocks/demoSeed';
import { handle, type MockState } from '../../mocks/ipcMock';
import { NO_FILTERS } from './engine';
import { buildAnalyticsSheets } from './sheets';
import { mkSnapshot } from './testkit';
import { publishAnalysisView, publishedAnalysisView } from './view';

beforeEach(polyfillDom);
afterEach(() => {
  clearMocks();
  publishAnalysisView(null);
});

type User = ReturnType<typeof userEvent.setup>;

const go = async (user: User, tab: string) => user.click(await screen.findByRole('tab', { name: tab }));

async function filterAnalysisToWebsite(user: User): Promise<void> {
  await go(user, 'Analysis');
  await user.click(await screen.findByText('Projects: all'));
  await user.click(screen.getByRole('checkbox', { name: 'Website' }));
}

async function exportExcel(user: User, s: MockState) {
  const before = s.exports.length;
  await user.click(await screen.findByRole('button', { name: /^Export/ }));
  const dialog = await screen.findByRole('dialog', { name: 'Export' });
  const hint = within(dialog).getByText(/analysis sheets for the same zone/).textContent ?? '';
  await user.click(within(dialog).getByRole('button', { name: 'Export Excel' }));
  await within(dialog).findByTestId('export-result');
  expect(s.exports).toHaveLength(before + 1);
  const sheets = s.exports[before]?.request.analytics ?? [];
  await user.click(within(dialog).getByRole('button', { name: 'Close' }));
  return { hint, sheets };
}

const totalExact = (sheets: { name: string; rows: (string | number | null)[][] }[]): unknown => sheets.find((x) => x.name === 'KPI summary')?.rows.find((r) => r[0] === 'Total time (Exact)')?.[1];

describe('R1: the filter of the Analysis tab in the Excel export', () => {
  it('every sheet title names the filter that applies', () => {
    const now = '2026-03-12T18:00:00Z';
    const snap = mkSnapshot({
      now,
      projects: [{ id: 'p1', name: 'Website' }, { id: 'p2', name: 'Packaging' }],
      tasks: [{ id: 'a', projectId: 'p1', state: 'stopped' }, { id: 'b', projectId: 'p2', state: 'stopped' }],
      segs: [['a', '2026-03-10T10:00:00Z', '2026-03-10T11:00:00Z'], ['b', '2026-03-10T12:00:00Z', '2026-03-10T15:00:00Z']],
      rates: [{ project: 'p1', cents: 6000 }],
    });
    const view = { range: { kind: 'week', anchor: '2026-03-10' } as const, filters: { ...NO_FILTERS, projectIds: ['p1'] }, basis: 'exact' as const, compare: false };
    const sheets = buildAnalyticsSheets(snap, 'UTC', parseIso(now), view);
    expect(sheets.length).toBeGreaterThan(3);
    for (const sheet of sheets) expect(sheet.title, sheet.name).toMatch(/, UTC, filtered to project Website$/);
    const none = buildAnalyticsSheets(snap, 'UTC', parseIso(now), { ...view, filters: NO_FILTERS });
    for (const sheet of none) expect(sheet.title, sheet.name).not.toMatch(/filtered/);
  });

  it('the view is dropped when the Analysis tab goes', async () => {
    const user = userEvent.setup();
    boot(demoState());
    await filterAnalysisToWebsite(user);
    expect(publishedAnalysisView()?.filters.projectIds).toEqual(['p-web']);
    await go(user, 'Timeline');
    expect(publishedAnalysisView()).toBeNull();
  });

  it('the dialog and the file say so while the filter is on screen', async () => {
    const user = userEvent.setup();
    const s = demoState();
    boot(s);
    await filterAnalysisToWebsite(user);
    const { hint, sheets } = await exportExcel(user, s);
    expect(hint).toMatch(/filtered to project Website/);
    // The days are cut in the zone of the dialog, which can differ from the tab's: the period and filters are the tab's.
    expect(hint).toMatch(/use the period and filters of the Analysis tab/);
    expect(sheets.length).toBeGreaterThan(3);
    for (const sheet of sheets) expect(sheet.title, sheet.name).toMatch(/filtered to project Website$/);
  });

  it('after leaving the tab the file and the dialog cover all history again, as if it were never opened', async () => {
    const user = userEvent.setup();
    const s = demoState();
    boot(s);
    const first = await exportExcel(user, s);
    await filterAnalysisToWebsite(user);
    await go(user, 'Timeline');
    const second = await exportExcel(user, s);
    expect(second.hint).not.toMatch(/filtered/);
    expect(second.hint).toMatch(/They cover all logged history: 23 Feb – 12 Mar 2026\./);
    for (const sheet of second.sheets) expect(sheet.title, sheet.name).not.toMatch(/filtered/);
    expect(second.sheets.map((x) => x.title)).toEqual(first.sheets.map((x) => x.title));
    // A task is running in the demo, so the totals may differ by the seconds between the two exports.
    expect(Math.abs(Number(totalExact(second.sheets)) - Number(totalExact(first.sheets)))).toBeLessThan(60);
  });

  it('a task filtered on, the tab left and the task deleted: the sheets still hold the time that is left', async () => {
    const user = userEvent.setup();
    const s = demoState();
    boot(s);
    await go(user, 'Analysis');
    await user.selectOptions(await screen.findByRole('combobox', { name: 'Task' }), 't-home');
    await go(user, 'Timeline');
    handle(s, 'delete_task', { id: 't-home' });
    await act(async () => {
      await emit('state-changed');
    });
    const { sheets } = await exportExcel(user, s);
    expect(Number(totalExact(sheets))).toBeGreaterThan(0);
  });
});
