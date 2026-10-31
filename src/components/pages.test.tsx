import { clearMocks } from '@tauri-apps/api/mocks';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { api } from '../lib/api';
import { demoState, DEMO_NOW } from '../mocks/demoSeed';
import { DEVICE_ID, type MockState } from '../mocks/ipcMock';
import { parseIso, toIso } from '../lib/tz';
import { boot as bootApp, polyfillDom } from './testKit';

beforeEach(polyfillDom);
afterEach(() => {
  clearMocks();
  vi.restoreAllMocks();
});

let state: MockState;
function boot(s: MockState) {
  state = s;
  return bootApp(s);
}
const calls = (cmd: string) => state.calls.filter((c) => c.cmd === cmd).map((c) => c.args as Record<string, unknown>);

async function go(user: ReturnType<typeof userEvent.setup>, tab: string) {
  await user.click(await screen.findByRole('tab', { name: tab }));
}

describe('projects tab', () => {
  it('requires a unique name and sends nothing when it is a duplicate', async () => {
    const user = userEvent.setup();
    boot(demoState());
    await go(user, 'Projects');
    await user.click(screen.getByRole('button', { name: 'New project' }));
    const form = screen.getByRole('form', { name: 'New project' });
    await user.click(within(form).getByRole('button', { name: 'Create project' }));
    expect(await within(form).findByText('Enter a project name.')).toBeVisible();
    await user.type(within(form).getByRole('textbox', { name: 'Project name' }), ' website ');
    await user.click(within(form).getByRole('button', { name: 'Create project' }));
    expect(await within(form).findByText(/already exists/)).toBeVisible();
    expect(calls('create_project')).toEqual([]);
  });

  it('creates a project with a colour, suggests an unused one, and records the price in the chosen currency', async () => {
    const user = userEvent.setup();
    boot(demoState());
    await go(user, 'Projects');
    await user.click(screen.getByRole('button', { name: 'New project' }));
    const form = screen.getByRole('form', { name: 'New project' });
    // Palette colours 1 to 4 are in use by the demo projects, so the suggestion is the fifth.
    expect(within(form).getByRole('radio', { name: 'Colour #7c3aed' })).toBeChecked();
    await user.type(within(form).getByRole('textbox', { name: 'Project name' }), 'Retail');
    await user.click(within(form).getByRole('radio', { name: 'Colour #db2777' }));
    await user.type(within(form).getByRole('textbox', { name: 'Price' }), '45.5');
    await user.selectOptions(within(form).getByRole('combobox', { name: 'Currency' }), 'EUR');
    await user.click(within(form).getByRole('button', { name: 'Create project' }));
    await waitFor(() => expect(state.projects.some((p) => p.name === 'Retail')).toBe(true));
    expect(state.projects.find((p) => p.name === 'Retail')?.color).toBe('#db2777');
    const rate = state.rates.find((r) => r.projectId === state.projects.find((p) => p.name === 'Retail')?.id);
    expect([rate?.rateCents, rate?.currency]).toEqual([4550, 'EUR']);
    expect(state.lastCurrency).toBe('EUR');
  });

  it('asks for confirmation before a price change that reaches into the past, and only then sends it', async () => {
    const user = userEvent.setup();
    boot(demoState());
    await go(user, 'Projects');
    await user.click(await screen.findByRole('button', { name: 'Edit Brand refresh' }));
    const form = screen.getByRole('form', { name: 'Edit project Brand refresh' });
    const price = within(form).getByRole('textbox', { name: 'Price' });
    await user.clear(price);
    await user.type(price, '100');
    await user.click(within(form).getByRole('radio', { name: 'Applies from a date' }));
    fireEvent.change(within(form).getByLabelText('From date'), { target: { value: '2026-03-01' } });
    await user.click(within(form).getByRole('button', { name: 'Save project' }));
    const dialog = await screen.findByRole('dialog', { name: 'Change past figures?' });
    expect(dialog).toHaveTextContent('earnings already shown');
    expect(calls('set_rate')).toEqual([]);
    expect(calls('update_project')).toEqual([]);
    await user.click(within(dialog).getByRole('button', { name: 'Apply to past dates' }));
    await waitFor(() => expect(calls('set_rate')).toHaveLength(1));
    expect(calls('set_rate')[0]).toMatchObject({ input: { projectId: 'p-brand', rateCents: 10000, currency: 'USD', effectiveFrom: '2026-03-01T00:00:00Z', confirmRetroactive: true } });
  });

  it('a price change from now needs no confirmation and sends no date', async () => {
    const user = userEvent.setup();
    boot(demoState());
    await go(user, 'Projects');
    await user.click(await screen.findByRole('button', { name: 'Edit Website' }));
    const form = screen.getByRole('form', { name: 'Edit project Website' });
    const price = within(form).getByRole('textbox', { name: 'Price' });
    await user.clear(price);
    await user.type(price, '65');
    await user.click(within(form).getByRole('button', { name: 'Save project' }));
    await waitFor(() => expect(calls('set_rate')).toHaveLength(1));
    const input = (calls('set_rate')[0] as { input: Record<string, unknown> }).input;
    expect(input).toMatchObject({ projectId: 'p-web', rateCents: 6500, currency: 'EUR' });
    expect(input.effectiveFrom).toBeUndefined();
  });

  it('keeps "no rate" apart from a zero rate and offers to set one', async () => {
    const user = userEvent.setup();
    const s = demoState();
    s.rates.push({ id: 'r-zero', projectId: 'p-pack', effectiveFrom: '2026-01-01T00:00:00Z', rateCents: 0, currency: 'EUR', deleted: false, stamp: { at: '', by: DEVICE_ID } });
    boot(s);
    await go(user, 'Projects');
    const rows = await screen.findAllByRole('heading', { level: 3 });
    const row = (name: string) => within(rows.find((h) => h.textContent === name)?.closest('li') as HTMLElement);
    expect(row('Packaging').getByText('€0.00/h')).toBeVisible();
    expect(row('Packaging').queryByText(/No rate set/)).toBeNull();
    expect(row('Admin').getByText('Non-billable')).toBeVisible();
  });

  it('archives a project with tasks, deletes one without, and restores', async () => {
    const user = userEvent.setup();
    const s = demoState();
    s.projects.push({ id: 'p-empty', name: 'Empty one', color: '#0891b2', archived: false, billable: true, budgetHours: null, clientZone: null, createdAt: '', hasTasks: false });
    boot(s);
    await go(user, 'Projects');
    expect(await screen.findByRole('button', { name: 'Archive Website' })).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Delete Website' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Archive Empty one' })).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Archive Website' }));
    expect(await screen.findByRole('button', { name: 'Restore Website' })).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Restore Website' }));
    expect(await screen.findByRole('button', { name: 'Archive Website' })).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Delete Empty one' }));
    await user.click(within(await screen.findByRole('dialog', { name: 'Delete this project?' })).getByRole('button', { name: 'Delete project' }));
    await waitFor(() => expect(state.projects.some((p) => p.id === 'p-empty')).toBe(false));
  });
});

describe('project rounding override', () => {
  it('adds an override from today for one project and lists it', async () => {
    const user = userEvent.setup();
    boot(demoState());
    await go(user, 'Projects');
    await user.click(await screen.findByRole('button', { name: 'Edit Website' }));
    const form = screen.getByRole('form', { name: 'Edit project Website' });
    expect(within(form).getByText('This project follows the global rounding in Settings.')).toBeVisible();
    await user.click(within(form).getByRole('checkbox', { name: 'Override the global rounding for this project' }));
    await user.selectOptions(within(form).getByRole('combobox', { name: 'Increment' }), '30');
    await user.selectOptions(within(form).getByRole('combobox', { name: 'Method' }), 'nearest');
    await user.click(within(form).getByRole('button', { name: 'Save project' }));
    await waitFor(() => expect(calls('set_rounding')).toHaveLength(1));
    expect(calls('set_rounding')[0]).toMatchObject({ input: { projectId: 'p-web', effectiveFrom: '2026-03-12', incrementMinutes: 30, method: 'nearest', confirmRetroactive: false }, today: '2026-03-12' });
    await user.click(await screen.findByRole('button', { name: 'Edit Website' }));
    expect(await screen.findByText('From 2026-03-12: 30 min, Nearest')).toBeVisible();
  });
});

describe('deleting a draft and reading a description', () => {
  it('deletes a draft only after confirming, and shows the description of a task read-only', async () => {
    const user = userEvent.setup();
    boot(demoState());
    await user.click(await screen.findByRole('button', { name: 'Delete draft Social templates' }));
    expect(calls('delete_draft')).toEqual([]);
    await user.click(within(screen.getByRole('dialog', { name: 'Delete this draft?' })).getByRole('button', { name: 'Delete draft' }));
    await waitFor(() => expect(calls('delete_draft')).toEqual([{ id: 't-next' }]));
    const logo = await screen.findByRole('article', { name: 'Logo concepts' });
    await user.click(within(logo).getByRole('button', { name: /Description/ }));
    const doc = await within(logo).findByRole('document', { name: 'Description of Logo concepts' });
    expect(doc).toHaveTextContent('Final artwork');
    expect(doc.querySelector('ol')).not.toBeNull();
    expect(doc).toHaveAttribute('contenteditable', 'false');
  });
});

describe('banners', () => {
  it('shows warnings without a way to dismiss them, and dismisses notices', async () => {
    const user = userEvent.setup();
    const s = demoState();
    s.warnings = ['The computer clock looks wrong.'];
    s.notices = [{ id: 'n1', level: 'info', message: 'Merged 3 changes from Office PC.' }];
    boot(s);
    expect(await screen.findByText('The computer clock looks wrong.')).toBeVisible();
    const notice = screen.getByTestId('notice');
    expect(within(screen.getByTestId('warning')).queryByRole('button')).toBeNull();
    await user.click(within(notice).getByRole('button', { name: /Dismiss notice/ }));
    await waitFor(() => expect(screen.queryByTestId('notice')).toBeNull());
    expect(calls('dismiss_notice')).toEqual([{ id: 'n1' }]);
    expect(screen.getByText('The computer clock looks wrong.')).toBeVisible();
  });

  it('reports a failed command as an error', async () => {
    const user = userEvent.setup();
    const s = demoState();
    boot(s);
    await go(user, 'Projects');
    await user.click(await screen.findByRole('button', { name: 'Archive Brand refresh' }));
    expect(await screen.findByRole('alert')).toHaveTextContent("pause or stop this project's running task");
  });
});

describe('settings', () => {
  it('confirms before a backdated rounding rule and then sends confirmRetroactive', async () => {
    const user = userEvent.setup();
    boot(demoState());
    await go(user, 'Settings');
    expect(await screen.findByTestId('current-rounding')).toHaveTextContent('15 min, Up');
    const card = within(screen.getByRole('region', { name: 'Rounding' }));
    await user.selectOptions(card.getByRole('combobox', { name: 'Increment' }), '30');
    await user.selectOptions(card.getByRole('combobox', { name: 'Method' }), 'nearest');
    fireEvent.change(card.getByLabelText('Effective from'), { target: { value: '2026-03-01' } });
    await user.click(card.getByRole('button', { name: 'Save rounding' }));
    const dialog = await screen.findByRole('dialog', { name: 'Apply to past dates?' });
    expect(calls('set_rounding')).toEqual([]);
    await user.click(within(dialog).getByRole('button', { name: 'Apply to past dates' }));
    await waitFor(() => expect(calls('set_rounding')).toHaveLength(1));
    expect(calls('set_rounding')[0]).toMatchObject({ input: { projectId: null, effectiveFrom: '2026-03-01', incrementMinutes: 30, method: 'nearest', confirmRetroactive: true }, today: '2026-03-12' });
    expect(await card.findByText(/From/, { selector: 'span' })).toHaveTextContent('From 2026-03-01: 30 min, Nearest');
  });

  it('saves a rule from today without a dialog, with custom minutes and Off', async () => {
    const user = userEvent.setup();
    boot(demoState());
    await go(user, 'Settings');
    const card = within(await screen.findByRole('region', { name: 'Rounding' }));
    await user.selectOptions(card.getByRole('combobox', { name: 'Increment' }), 'custom');
    fireEvent.change(card.getByRole('spinbutton', { name: 'Custom minutes' }), { target: { value: '7' } });
    await user.click(card.getByRole('button', { name: 'Save rounding' }));
    await waitFor(() => expect(calls('set_rounding')).toHaveLength(1));
    expect(calls('set_rounding')[0]).toMatchObject({ input: { incrementMinutes: 7, method: 'up', confirmRetroactive: false } });
    await user.selectOptions(card.getByRole('combobox', { name: 'Increment' }), '0');
    await user.click(card.getByRole('button', { name: 'Save rounding' }));
    await waitFor(() => expect(calls('set_rounding')).toHaveLength(2));
    expect(calls('set_rounding')[1]).toMatchObject({ input: { incrementMinutes: 0 } });
  });

  it('changes the theme, the client working hours and autostart', async () => {
    const user = userEvent.setup();
    boot(demoState());
    await go(user, 'Settings');
    await user.click(await screen.findByRole('radio', { name: 'Solarized Light' }));
    await waitFor(() => expect(state.theme).toBe('solarizedLight'));
    expect(document.documentElement.dataset.theme).toBe('solarizedLight');
    fireEvent.change(screen.getByLabelText('Client working hours start'), { target: { value: '08:30' } });
    await waitFor(() => expect(state.settings.clientWorkStart).toBe('08:30'));
    const autostart = await screen.findByRole('switch', { name: /Start Labor Tracker/ });
    await waitFor(() => expect(autostart).toBeEnabled());
    expect(autostart).not.toBeChecked();
    await user.click(autostart);
    await waitFor(() => expect(state.autostart).toBe(true));
  });

  it('saves a night preset as an overnight shift in My zone', async () => {
    const user = userEvent.setup();
    boot(demoState());
    await go(user, 'Settings');
    await user.click(await screen.findByRole('button', { name: 'Add Night preset' }));
    const form = screen.getByRole('form', { name: 'New shift' });
    expect(within(form).getByRole('textbox', { name: 'Shift name' })).toHaveValue('Night');
    expect(within(form).getByText(/Ends the next day/)).toBeVisible();
    await user.click(within(form).getByRole('button', { name: 'Save shift' }));
    await waitFor(() => expect(calls('save_shift')).toHaveLength(1));
    expect(calls('save_shift')[0]).toMatchObject({ input: { name: 'Night', start: '22:00', end: '06:00', zone: 'Europe/Lisbon', weekdays: [1, 2, 3, 4, 5], breakMinutes: 30, effectiveFrom: '2026-03-12' } });
    expect(await screen.findByText(/22:00–06:00 \(next day\)/)).toBeVisible();
  });

  it('refuses a shift without a weekday and shows why', async () => {
    const user = userEvent.setup();
    boot(demoState());
    await go(user, 'Settings');
    await user.click(await screen.findByRole('button', { name: 'New shift' }));
    const form = screen.getByRole('form', { name: 'New shift' });
    await user.type(within(form).getByRole('textbox', { name: 'Shift name' }), 'Odd');
    for (const d of ['Mon', 'Tue', 'Wed', 'Thu', 'Fri']) await user.click(within(form).getByRole('button', { name: new RegExp(`^${d}`) }));
    await user.click(within(form).getByRole('button', { name: 'Save shift' }));
    expect(await within(form).findByText('Choose at least one weekday.')).toBeVisible();
    expect(calls('save_shift')).toEqual([]);
  });

  it('retires a shift by saving a retired version from today, and deleting asks first', async () => {
    const user = userEvent.setup();
    boot(demoState());
    await go(user, 'Settings');
    await user.click(await screen.findByRole('button', { name: 'Retire Morning' }));
    await waitFor(() => expect(calls('save_shift')).toHaveLength(1));
    expect(calls('save_shift')[0]).toMatchObject({ input: { shiftId: 'sh-morning', retired: true, effectiveFrom: '2026-03-12' } });
    expect(await screen.findByRole('button', { name: 'Reactivate Morning' })).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Delete US coverage' }));
    expect(calls('delete_shift')).toEqual([]);
    await user.click(within(screen.getByRole('dialog', { name: 'Delete this shift?' })).getByRole('button', { name: 'Delete shift' }));
    await waitFor(() => expect(calls('delete_shift')).toEqual([{ shiftId: 'sh-coverage' }]));
  });
});

describe('sync', () => {
  const target = (written: string | null) => ({
    provider: 'oneDrive' as const,
    root: 'C:\\Users\\me\\OneDrive',
    folder: 'C:\\Users\\me\\OneDrive\\LaborTracker',
    status: { lastWrittenAt: written, lastReadAt: toIso(parseIso(DEMO_NOW) - 600), lastError: 'Access denied', lastErrorAt: toIso(parseIso(DEMO_NOW) - 3600), warnings: ['Another device has a newer app version.'], ignoredFiles: 2, devicesSeen: 1 },
  });

  it('lists each target with what the app can honestly say, and removes it only after confirming', async () => {
    const user = userEvent.setup();
    const s = demoState();
    s.targets = [target(toIso(parseIso(DEMO_NOW) - 120))];
    boot(s);
    await go(user, 'Settings');
    expect(await screen.findByTestId('sync-written')).toHaveTextContent('Written to OneDrive folder, 2 min ago');
    expect(screen.getByText(/cannot confirm that it has/)).toBeVisible();
    expect(screen.getByText('Another device has a newer app version.')).toBeVisible();
    expect(screen.getByText(/Last error \(1 h ago\): Access denied/)).toBeVisible();
    expect(screen.getAllByText(/leaves this computer only through the folder you choose/).length).toBeGreaterThan(0);
    await user.click(screen.getByRole('button', { name: /^Remove C:/ }));
    const dialog = screen.getByRole('dialog', { name: 'Stop syncing with this folder?' });
    expect(dialog).toHaveTextContent('stay where they are');
    expect(calls('remove_sync_target')).toEqual([]);
    await user.click(within(dialog).getByRole('button', { name: 'Remove folder' }));
    await waitFor(() => expect(calls('remove_sync_target')).toEqual([{ root: 'C:\\Users\\me\\OneDrive' }]));
    expect(await screen.findByText(/Sync is off/)).toBeVisible();
  });

  it('offers a detected folder unchecked, shows what is already inside, and connects only on request', async () => {
    const user = userEvent.setup();
    const s = demoState();
    s.detected = [
      { provider: 'oneDrive', root: 'C:\\Users\\me\\OneDrive', source: 'the OneDrive setting' },
      { provider: 'googleDrive', root: 'G:\\My Drive', source: 'a mounted drive' },
    ];
    vi.spyOn(api, 'previewSyncFolder').mockResolvedValue({ hasData: true, devices: ['Office PC'], projects: 4, tasks: 12, segments: 300, warnings: [] });
    boot(s);
    await go(user, 'Settings');
    await user.click(await screen.findByRole('button', { name: 'Add a folder' }));
    const one = screen.getByLabelText('OneDrive folder (C:\\Users\\me\\OneDrive)');
    const google = screen.getByLabelText('Google Drive folder (G:\\My Drive)');
    expect(one).not.toBeChecked();
    expect(google).not.toBeChecked();
    expect(screen.getByRole('button', { name: 'Connect folder' })).toBeDisabled();
    await user.click(one);
    const preview = await screen.findByTestId('sync-preview');
    expect(preview).toHaveTextContent('already holds Labor Tracker data from 1 device (Office PC): 4 projects, 12 tasks, 300 time segments');
    expect(preview).toHaveTextContent('merges it');
    await user.click(google);
    await user.click(screen.getByRole('button', { name: 'Connect 2 folders' }));
    await waitFor(() => expect(state.targets.map((t) => t.provider)).toEqual(['oneDrive', 'googleDrive']));
  });

  it('adds a folder chosen with the picker as a custom target', async () => {
    const user = userEvent.setup();
    boot(demoState());
    await go(user, 'Settings');
    await user.click(await screen.findByRole('button', { name: 'Add a folder' }));
    expect(screen.getByTestId('sync-guide')).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Choose another folder' }));
    const box = await screen.findByLabelText('Folder (/mock/picked-folder)');
    expect(box).toBeChecked();
    await user.click(screen.getByRole('button', { name: 'Connect folder' }));
    await waitFor(() => expect(state.targets).toHaveLength(1));
    expect(state.targets[0]).toMatchObject({ provider: 'custom', root: '/mock/picked-folder' });
  });
});

describe('about', () => {
  it('shows app, tzdata and attribution text', async () => {
    const user = userEvent.setup();
    boot(demoState());
    await go(user, 'Settings');
    expect(await screen.findByTestId('app-version')).toHaveTextContent(/^\d+\.\d+\.\d+/);
    expect(screen.getByTestId('tzdb-ui')).not.toBeEmptyDOMElement();
    expect(screen.getByTestId('tzdb-backend')).toHaveTextContent('mock');
    expect(screen.getByText(/the fix arrives with an app update/)).toBeVisible();
    expect(screen.getByTestId('zone-data-attribution')).toBeVisible();
  });
});
