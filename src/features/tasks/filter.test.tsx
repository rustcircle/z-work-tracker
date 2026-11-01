// The one task filter, in the task list and on the Timeline, through the real app on the IPC mock.
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

const railNames = (): string[] => within(screen.getByRole('complementary', { name: 'Tasks' })).queryAllByRole('heading', { level: 3 }).map((h) => h.textContent ?? '').filter((t) => !['Active', 'Drafts', 'Stopped'].some((g) => t.startsWith(g)));
const entryNames = (): string[] => [...new Set(screen.queryAllByTestId('entry').map((r) => within(r).getAllByRole('button')[0]?.textContent ?? ''))].sort();

async function open() {
  const user = userEvent.setup();
  boot(demoP2State());
  await screen.findByRole('region', { name: 'Timeline' });
  // The time-away dialog opens on this seed; the filter is not about it.
  await user.keyboard('{Escape}');
  return user;
}

describe('the task filter', () => {
  it('finds a task by a list item in its description, in the task list and on the Timeline at once, and says how many match', async () => {
    const user = await open();
    const rail = screen.getByTestId('task-filter-tasks');
    await user.type(within(rail).getByRole('searchbox'), 'sketches');
    await waitFor(() => expect(railNames()).toEqual(['Logo concepts']));
    expect(within(rail).getByTestId('task-filter-status')).toHaveTextContent(/1 of \d+ tasks match/);
    // The Timeline, which shares the filter, only draws that task, and its own box shows the same text.
    await waitFor(() => expect(entryNames()).toEqual(['Logo concepts']));
    expect(within(screen.getByTestId('task-filter-timeline')).getByRole('searchbox')).toHaveValue('sketches');
    expect(screen.getByLabelText('Period totals')).toHaveTextContent(/follow the task filter/);
  });

  it('is accent and case insensitive, and ignores spaces around what was typed', async () => {
    const user = await open();
    const box = within(screen.getByTestId('task-filter-timeline')).getByRole('searchbox');
    await user.type(box, '  LOGO  ');
    await waitFor(() => expect(entryNames()).toEqual(['Logo concepts']));
  });

  it('a tag narrows it, AND the text, and Clear brings everything back from either bar', async () => {
    const user = await open();
    const bar = screen.getByTestId('task-filter-timeline');
    await user.click(within(bar).getByRole('checkbox', { name: 'Filter timeline by tag Revision' }));
    await waitFor(() => expect(entryNames()).toEqual(['Brand guidelines', 'Homepage layout', 'Print proofs']));
    await user.type(within(bar).getByRole('searchbox'), 'homepage');
    await waitFor(() => expect(entryNames()).toEqual(['Homepage layout']));
    // The other bar clears it all.
    await user.click(within(screen.getByTestId('task-filter-tasks')).getByRole('button', { name: 'Clear filter' }));
    await waitFor(() => expect(entryNames().length).toBeGreaterThan(2));
    expect(within(bar).getByRole('searchbox')).toHaveValue('');
    expect(within(bar).getByRole('checkbox', { name: 'Filter timeline by tag Revision' })).not.toBeChecked();
  });

  it('filters by project, and says so when nothing matches', async () => {
    const user = await open();
    const bar = screen.getByTestId('task-filter-timeline');
    await user.selectOptions(within(bar).getByRole('combobox', { name: 'Filter timeline by project' }), 'p-web');
    await waitFor(() => expect(entryNames()).toEqual(['Homepage layout']));
    await user.type(within(bar).getByRole('searchbox'), 'nothing like this');
    expect(await screen.findByText(/No logged time matches this filter/)).toBeVisible();
    expect(within(bar).getByTestId('task-filter-status')).toHaveTextContent('0 of');
  });

  it('waits for a pause in typing before filtering', async () => {
    const user = await open();
    const before = entryNames();
    const box = within(screen.getByTestId('task-filter-timeline')).getByRole('searchbox');
    await user.type(box, 'l');
    // Nothing yet: the debounce has not elapsed.
    expect(entryNames()).toEqual(before);
    await waitFor(() => expect(entryNames()).not.toEqual(before));
  });
});
