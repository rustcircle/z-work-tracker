// Settings > Start with Windows (design test 69): the switch shows what Windows says, in each of its states, and the one state where
// only the user can act has a button that opens Windows' own Startup settings.
import { clearMocks } from '@tauri-apps/api/mocks';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { boot as bootApp, polyfillDom } from '../../components/testKit';
import { api } from '../../lib/api';
import type { AutostartInfo, AutostartState } from '../../lib/types';
import { demoState } from '../../mocks/demoSeed';
import { autostartFor, type MockState } from '../../mocks/ipcMock';

beforeEach(polyfillDom);
afterEach(() => {
  clearMocks();
  vi.restoreAllMocks();
});

let state: MockState;
const calls = (cmd: string) => state.calls.filter((c) => c.cmd === cmd).map((c) => c.args as Record<string, unknown>);

async function open(which: AutostartState, packaged = true) {
  const user = userEvent.setup();
  const s = demoState();
  s.packaged = packaged;
  s.autostartInfo = autostartFor(which, packaged);
  if (which === 'on') s.autostart = true;
  state = s;
  bootApp(s);
  await user.click(await screen.findByRole('tab', { name: 'Settings' }));
  const region = within(await screen.findByRole('region', { name: 'Start with Windows' }));
  const toggle = await region.findByRole('switch', { name: 'Start zWorkTracker when I sign in to Windows' });
  // The switch waits for Windows' answer before it can be used.
  await waitFor(() => expect(calls('get_autostart_info')).toHaveLength(1));
  return { user, region, toggle };
}

/** What Windows says in each state, and what the switch and the button do. */
const STATES: { state: AutostartState; on: boolean; enabled: boolean; note: string | null; button: boolean }[] = [
  { state: 'on', on: true, enabled: true, note: null, button: false },
  { state: 'off', on: false, enabled: true, note: null, button: false },
  { state: 'offByUser', on: false, enabled: false, note: 'You turned this off in Windows, so only Windows can turn it back on: Settings > Apps > Startup.', button: true },
  { state: 'offByPolicy', on: false, enabled: false, note: "A policy on this computer doesn't allow this, or the device doesn't support it.", button: false },
  { state: 'onByPolicy', on: true, enabled: false, note: 'A policy on this computer keeps this on.', button: false },
  { state: 'unavailable', on: false, enabled: false, note: "Windows couldn't find this app's startup entry.", button: false },
];

describe('what Windows says about starting with it', () => {
  it.each(STATES)('$state: the switch is $on, it can be changed: $enabled, and the text is its own', async ({ state: which, on, enabled, note, button }) => {
    const { region, toggle } = await open(which);
    await waitFor(() => (enabled ? expect(toggle).toBeEnabled() : expect(toggle).toBeDisabled()));
    if (on) expect(toggle).toBeChecked();
    else expect(toggle).not.toBeChecked();
    if (note === null) expect(region.queryByTestId('autostart-note')).toBeNull();
    else expect(region.getByTestId('autostart-note')).toHaveTextContent(note);
    const open_ = region.queryByRole('button', { name: 'Open Startup settings' });
    if (button) expect(open_).toBeVisible();
    else expect(open_).toBeNull();
  });

  it('is called Start with Windows in the menu and in the jump list', async () => {
    await open('off');
    expect(screen.getByRole('button', { name: 'Start with Windows' })).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Startup' })).toBeNull();
  });

  it('never says the app starts hidden: it opens when you sign in', async () => {
    const { region } = await open('off');
    expect(region.getByText('Off by default. When it is on, zWorkTracker opens when you sign in to Windows.')).toBeVisible();
    expect(document.body.textContent).not.toMatch(/hidden in the system tray/i);
  });

  it('says that Windows has the last word in the Store version, and not in the installer build', async () => {
    const store = await open('off');
    expect(store.region.getByText('This is the Microsoft Store version, so Windows has the last word on this switch.')).toBeVisible();
  });

  it('does not say it in the installer build', async () => {
    const { region } = await open('off', false);
    expect(region.queryByText(/Microsoft Store version/)).toBeNull();
  });
});

describe('the words', () => {
  /** What Windows says, when it says it in a way of its own and not the way the mock backend does. */
  async function openSaying(info: AutostartInfo) {
    const user = userEvent.setup();
    const s = demoState();
    state = s;
    vi.spyOn(api, 'getAutostartInfo').mockResolvedValue(info);
    bootApp(s);
    await user.click(await screen.findByRole('tab', { name: 'Settings' }));
    return within(await screen.findByRole('region', { name: 'Start with Windows' }));
  }

  it('are the ones Windows sends when it sends its own', async () => {
    const region = await openSaying({ packaged: true, state: 'offByPolicy', canChange: false, note: 'Your organisation manages the startup apps of this computer.' });
    expect(await region.findByTestId('autostart-note')).toHaveTextContent('Your organisation manages the startup apps of this computer.');
    expect(region.getByTestId('autostart-note')).not.toHaveTextContent("A policy on this computer doesn't allow this");
  });

  it("are the app's own when Windows sends none", async () => {
    const region = await openSaying({ packaged: true, state: 'offByUser', canChange: false, note: null });
    expect(await region.findByTestId('autostart-note')).toHaveTextContent('You turned this off in Windows, so only Windows can turn it back on: Settings > Apps > Startup.');
  });
});

describe('the button', () => {
  it('opens the Startup settings of Windows, and does nothing else', async () => {
    const { user, region } = await open('offByUser');
    await user.click(region.getByRole('button', { name: 'Open Startup settings' }));
    await waitFor(() => expect(calls('open_startup_settings')).toHaveLength(1));
    expect(calls('set_autostart')).toEqual([]);
  });

  it('shows what went wrong when Windows can\'t be asked', async () => {
    const { user, region } = await open('offByUser');
    vi.spyOn(api, 'openStartupSettings').mockRejectedValue({ code: 'io', message: 'Startup settings could not be opened.' });
    await user.click(region.getByRole('button', { name: 'Open Startup settings' }));
    expect(await screen.findByText('Startup settings could not be opened.')).toBeVisible();
  });
});

describe('the switch', () => {
  it('turns it on and shows what Windows says after', async () => {
    const { user, toggle } = await open('off');
    await user.click(toggle);
    await waitFor(() => expect(toggle).toBeChecked());
    expect(calls('set_autostart')).toEqual([{ enabled: true }]);
    expect(calls('get_autostart_info').length).toBeGreaterThanOrEqual(2);
  });

  it('turns it off again', async () => {
    const { user, toggle } = await open('on');
    await user.click(toggle);
    await waitFor(() => expect(toggle).not.toBeChecked());
    expect(calls('set_autostart')).toEqual([{ enabled: false }]);
  });

  it('shows the refusal, and the state Windows is in now, when it turned the switch down', async () => {
    const { user, region, toggle } = await open('off');
    // Between the page asking and the click, the user turned it off in Windows' own settings.
    state.autostartInfo = autostartFor('offByUser');
    await user.click(toggle);
    expect(await screen.findByRole('alert')).toHaveTextContent('You turned this off in Windows, so only Windows can turn it back on: Settings > Apps > Startup.');
    await waitFor(() => expect(toggle).toBeDisabled());
    expect(toggle).not.toBeChecked();
    expect(await region.findByRole('button', { name: 'Open Startup settings' })).toBeVisible();
  });

  it('asks Windows with get_autostart_info, and not with the call the setup wizard keeps using', async () => {
    const { toggle } = await open('off');
    expect(toggle).not.toBeChecked();
    expect(calls('get_autostart')).toEqual([]);
  });
});

describe('when Windows can\'t be asked at all', () => {
  it('says so and leaves the switch alone', async () => {
    const user = userEvent.setup();
    const s = demoState();
    state = s;
    vi.spyOn(api, 'getAutostartInfo').mockRejectedValue({ code: 'io', message: 'no' });
    bootApp(s);
    await user.click(await screen.findByRole('tab', { name: 'Settings' }));
    const region = within(await screen.findByRole('region', { name: 'Start with Windows' }));
    expect(await region.findByRole('alert')).toHaveTextContent("Couldn't find out whether this is on.");
    expect(region.getByRole('switch', { name: 'Start zWorkTracker when I sign in to Windows' })).toBeDisabled();
  });
});
