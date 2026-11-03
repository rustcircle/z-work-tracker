// While another computer is using the app, the backend refuses every change to shared data (design 9.5). The settings sections that
// write such data switch their controls off before the click and say why, and a computer that holds the lease sees none of it.
import { emit } from '@tauri-apps/api/event';
import { clearMocks } from '@tauri-apps/api/mocks';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { boot as bootApp, polyfillDom } from '../../components/testKit';
import { demoState } from '../../mocks/demoSeed';
import { handle, loseLease, seedLease, type LeaseSeed, type MockState } from '../../mocks/ipcMock';

beforeEach(polyfillDom);
afterEach(() => {
  clearMocks();
  vi.restoreAllMocks();
});

const WHY = 'LAPTOP is using zWorkTracker, so this computer is read-only. Take over from the banner to work here.';

let state: MockState;
const calls = (cmd: string) => state.calls.filter((c) => c.cmd === cmd).map((c) => c.args as Record<string, unknown>);

/** A store with something in every list the settings sections edit, then the lease the test asks for. */
async function open(lease: LeaseSeed | null) {
  const user = userEvent.setup();
  const s = demoState();
  handle(s, 'save_shift', { input: { shiftId: null, effectiveFrom: '2026-03-01', name: 'Early shift', color: '#2563eb', start: '08:00', end: '12:00', weekdays: [1, 2, 3, 4, 5], zone: 'Europe/Lisbon', breakMinutes: 0 } });
  handle(s, 'save_template', { input: { id: null, name: 'Weekly review', projectId: null, description: null, tags: [] } });
  handle(s, 'set_rounding', { input: { projectId: null, effectiveFrom: '2026-03-12', incrementMinutes: 30, method: 'up', confirmRetroactive: false }, today: '2026-03-12' });
  s.backups = [{ name: 'z-work-data-2026-03-11.json', bytes: 47_960, safety: false }];
  if (lease !== null) seedLease(s, lease);
  s.calls.length = 0;
  state = s;
  bootApp(s);
  await user.click(await screen.findByRole('tab', { name: 'Settings' }));
  await screen.findByRole('region', { name: 'Settings' });
  return { user, s };
}

const section = (name: string) => screen.getByRole('region', { name });

/** Everything a person could press or type into in a section. */
const controls = (name: string) => [...section(name).querySelectorAll<HTMLElement>('button, input, select, textarea')];
const enabled = (name: string) => controls(name).filter((c) => !c.matches(':disabled'));
const label = (el: HTMLElement) => el.getAttribute('aria-label') ?? el.textContent?.trim() ?? el.id;

/** The sections whose controls all write shared data. */
const WRITING = ['Time zones', 'Rounding', 'Targets', 'Shifts', 'Tags', 'Templates', 'Billing references', 'Time away and reminders'];

describe('while another computer is using the app', () => {
  it.each(WRITING)('%s: every control is off, and it says why', async (name) => {
    await open('live');
    await waitFor(() => expect(within(section(name)).getByTestId('read-only-note')).toHaveTextContent(WHY));
    expect(controls(name).length).toBeGreaterThan(0);
    expect(enabled(name).map(label)).toEqual([]);
  });

  it('Backups: Restore is off and says why, but the number of backups to keep is a setting of this computer and stays', async () => {
    await open('live');
    const backups = within(section('Backups'));
    expect(await backups.findByTestId('read-only-note')).toHaveTextContent(WHY);
    expect(backups.getByRole('button', { name: 'Restore z-work-data-2026-03-11.json' })).toBeDisabled();
    expect(backups.getByRole('textbox', { name: 'Daily backups to keep' })).toBeEnabled();
  });

  it('keeps the sections of this computer alone: appearance, sync, history', async () => {
    await open('live');
    await screen.findByRole('region', { name: 'Appearance' });
    expect(enabled('Appearance').length).toBeGreaterThan(0);
    expect(within(section('Appearance')).queryByTestId('read-only-note')).toBeNull();
    expect(within(section('Sync between devices')).queryByTestId('read-only-note')).toBeNull();
    expect(within(section('Sync between devices')).getByRole('button', { name: 'Sync now' })).toBeEnabled();
    expect(within(section('History of changes')).queryByTestId('read-only-note')).toBeNull();
  });

  it('refuses nothing, because nothing is sent: no setting, shift, tag, template or prefix is written', async () => {
    const { user } = await open('live');
    await waitFor(() => expect(within(section('Time zones')).getByTestId('read-only-note')).toBeVisible());
    for (const button of [
      within(section('Time zones')).getByRole('button', { name: 'Change my zone' }),
      within(section('Shifts')).getByRole('button', { name: 'New shift' }),
      within(section('Tags')).getByRole('button', { name: 'Add tag' }),
      within(section('Templates')).getByRole('button', { name: 'New template' }),
      within(section('Rounding')).getByRole('button', { name: 'Save rounding' }),
      within(section('Billing references')).getByRole('button', { name: 'Save prefix' }),
    ]) {
      expect(button).toBeDisabled();
      await user.click(button);
    }
    expect(calls('set_setting')).toEqual([]);
    expect(calls('save_shift')).toEqual([]);
    expect(calls('save_tag')).toEqual([]);
    expect(calls('save_template')).toEqual([]);
    expect(calls('set_rounding')).toEqual([]);
    expect(calls('set_device_prefix')).toEqual([]);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('switches off the controls that edit what is already there: a shift, a template, a rounding rule', async () => {
    await open('live');
    await waitFor(() => expect(within(section('Shifts')).getByTestId('read-only-note')).toBeVisible());
    expect(within(section('Shifts')).getByRole('button', { name: 'Edit Early shift' })).toBeDisabled();
    expect(within(section('Shifts')).getByRole('button', { name: 'Retire Early shift' })).toBeDisabled();
    expect(within(section('Shifts')).getByRole('button', { name: 'Delete Early shift' })).toBeDisabled();
    expect(within(section('Templates')).getByRole('button', { name: 'Edit template Weekly review' })).toBeDisabled();
    expect(within(section('Templates')).getByRole('button', { name: 'Delete template Weekly review' })).toBeDisabled();
    expect(within(section('Rounding')).getByRole('button', { name: 'Remove the rule from 2026-03-12' })).toBeDisabled();
  });

  it('also stops a form that was open when the lease went: the fields can be read and Cancel works, but nothing can be saved', async () => {
    const { user } = await open('mine');
    const tags = within(section('Tags'));
    await user.click(tags.getByRole('button', { name: 'Add tag' }));
    await user.type(await tags.findByRole('textbox', { name: 'Tag name' }), 'Urgent');
    act(() => loseLease(state));
    await act(async () => {
      await emit('state-changed');
    });
    await waitFor(() => expect(tags.getByRole('button', { name: 'Add tag' })).toBeDisabled());
    expect(tags.getByTestId('read-only-note')).toHaveTextContent(WHY);
    expect(tags.getByRole('textbox', { name: 'Tag name' })).toHaveValue('Urgent');
    await user.keyboard('{Enter}');
    expect(calls('save_tag')).toEqual([]);
    // The button is off, so Enter does nothing. A submit that comes some other way is stopped by the form itself.
    fireEvent.submit(tags.getByRole('form', { name: 'New tag' }));
    expect(calls('save_tag')).toEqual([]);
    await user.click(tags.getByRole('button', { name: 'Cancel' }));
    expect(tags.queryByRole('textbox', { name: 'Tag name' })).toBeNull();
  });

  it('stops a shift that was filled in when the lease went from being saved, however it is submitted', async () => {
    const { user } = await open('mine');
    const shifts = within(section('Shifts'));
    await user.click(shifts.getByRole('button', { name: 'New shift' }));
    await user.type(await shifts.findByRole('textbox', { name: 'Shift name' }), 'Late shift');
    act(() => loseLease(state));
    await act(async () => {
      await emit('state-changed');
    });
    await waitFor(() => expect(shifts.getByRole('button', { name: 'Save shift' })).toBeDisabled());
    fireEvent.submit(shifts.getByRole('form', { name: 'New shift' }));
    expect(calls('save_shift')).toEqual([]);
    expect(shifts.getByRole('textbox', { name: 'Shift name' })).toHaveValue('Late shift');
  });
});

describe('while this computer may change data', () => {
  it.each<[string, LeaseSeed | null]>([
    ['it holds the lease', 'mine'],
    ['nobody holds it', 'free'],
    ['the first look at the folders is not back', 'checking'],
    ['no folder is connected', null],
  ])('%s: no section says anything, and its controls work', async (_, lease) => {
    await open(lease);
    await screen.findByRole('region', { name: 'Time zones' });
    expect(screen.queryAllByTestId('read-only-note')).toHaveLength(0);
    for (const name of WRITING) expect(enabled(name).length, name).toBeGreaterThan(0);
    expect(within(section('Backups')).getByRole('button', { name: 'Restore z-work-data-2026-03-11.json' })).toBeEnabled();
  });

  it('writes a setting as it always did', async () => {
    const { user } = await open('mine');
    const targets = within(section('Targets'));
    const daily = targets.getByRole('textbox', { name: 'Daily target (hours)' });
    await user.clear(daily);
    await user.type(daily, '6.5');
    await user.click(targets.getByRole('button', { name: 'Save targets' }));
    await waitFor(() => expect(calls('set_setting')).toEqual([{ key: 'dailyTargetHours', value: 6.5 }, { key: 'weeklyTargetHours', value: 30 }]));
  });
});

describe('when the lease changes under an open Settings tab', () => {
  it('switches the controls off when another computer takes over, with no reload', async () => {
    await open('mine');
    await screen.findByRole('region', { name: 'Time zones' });
    expect(enabled('Time zones').length).toBeGreaterThan(0);
    act(() => loseLease(state));
    await act(async () => {
      await emit('state-changed');
    });
    await waitFor(() => expect(enabled('Time zones')).toEqual([]));
    expect(within(section('Time zones')).getByTestId('read-only-note')).toBeVisible();
  });

  it('switches them on again when this computer takes it back', async () => {
    const { user } = await open('live');
    await waitFor(() => expect(enabled('Tags')).toEqual([]));
    seedLease(state, 'mine');
    await act(async () => {
      await emit('state-changed');
    });
    await waitFor(() => expect(enabled('Tags').length).toBeGreaterThan(0));
    expect(screen.queryAllByTestId('read-only-note')).toHaveLength(0);
    await user.click(within(section('Tags')).getByRole('button', { name: 'Add tag' }));
    expect(await within(section('Tags')).findByRole('textbox', { name: 'Tag name' })).toBeVisible();
  });
});
