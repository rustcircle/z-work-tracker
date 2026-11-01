// Analysis can be narrowed by task name and description, with the same rules as the task filter.
import { clearMocks } from '@tauri-apps/api/mocks';
import { cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { boot, polyfillDom } from '../../components/testKit';
import { demoP2State } from '../../mocks/demoSeed';

beforeEach(() => polyfillDom());
afterEach(() => {
  cleanup();
  clearMocks();
});

describe('Analysis search', () => {
  it('narrows every figure to the tasks that match, case and accent insensitively, and Clear filters undoes it', async () => {
    const user = userEvent.setup();
    boot(demoP2State());
    await screen.findByRole('region', { name: 'Timeline' });
    await user.keyboard('{Escape}');
    await user.click(screen.getByRole('tab', { name: 'Analysis' }));
    const analysis = await screen.findByRole('region', { name: 'Analysis' });
    const filters = analysis;
    const search = within(filters).getByRole('searchbox', { name: 'Search tasks by name or description' });
    const hours = (): string => within(analysis).getAllByRole('heading', { level: 3 }).map((h) => h.textContent).join('|');
    const before = hours();
    await user.type(search, 'SKETCHES');
    await waitFor(() => expect(within(filters).getByTestId('analysis-search-status')).toHaveTextContent('1 task matches'));
    await waitFor(() => expect(hours()).not.toEqual(before));
    await user.click(within(filters).getByRole('button', { name: 'Clear filters' }));
    await waitFor(() => expect(search).toHaveValue(''));
    await waitFor(() => expect(hours()).toEqual(before));
  });

  it('says so when nothing matches, and shows no time rather than all of it', async () => {
    const user = userEvent.setup();
    boot(demoP2State());
    await screen.findByRole('region', { name: 'Timeline' });
    await user.keyboard('{Escape}');
    await user.click(screen.getByRole('tab', { name: 'Analysis' }));
    const analysis = await screen.findByRole('region', { name: 'Analysis' });
    await user.type(within(analysis).getByRole('searchbox', { name: 'Search tasks by name or description' }), 'qqqq');
    await waitFor(() => expect(within(analysis).getByTestId('analysis-search-status')).toHaveTextContent('0 tasks match'));
    expect(await within(analysis).findByText(/No logged time here/)).toBeVisible();
  });
});
