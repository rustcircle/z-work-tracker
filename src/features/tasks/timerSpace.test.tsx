// Space never starts, pauses, resumes, stops or continues a timer. The app is worked with the mouse, so a Space press that lands on a
// timer button (one a click left focused, or one reached with Tab) must do nothing at all, while Enter and a click press it as before.
// Each case below drives one place that sends a timer command, through the whole app on the mock backend.
import { clearMocks } from '@tauri-apps/api/mocks';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { boot as bootApp, polyfillDom } from '../../components/testKit';
import { demoState } from '../../mocks/demoSeed';
import { OTHER_DEVICE_ID, relaunch, type MockState } from '../../mocks/ipcMock';

let state: MockState;
beforeEach(polyfillDom);
afterEach(() => {
  cleanup();
  clearMocks();
});

type User = ReturnType<typeof userEvent.setup>;

function boot(s: MockState) {
  state = s;
  return bootApp(s);
}
const calls = (cmd: string) => state.calls.filter((c) => c.cmd === cmd).map((c) => c.args as Record<string, unknown>);
const task = (id: string) => state.tasks.find((t) => t.id === id);
const TIMER_COMMANDS = ['create_task', 'start_task', 'resume_task', 'pause_task', 'stop_task', 'request_remote_pause', 'settle_lost_segment'];
/** The timer commands sent so far, in order. */
const sent = () => state.calls.filter((c) => TIMER_COMMANDS.includes(c.cmd)).map((c) => c.cmd);
/** Everything a timer command could change. */
const world = () => JSON.stringify({ tasks: state.tasks, segments: state.segments, pauseRequests: state.pauseRequests });

const SPACE = { key: ' ', code: 'Space' } as const;

/**
 * Space reaches a focused button every way a keyboard can send it: pressed and let go (the browser's click comes with the key
 * coming up), and held down with the repeats of a held key.
 */
async function pressSpace(user: User, button: HTMLElement): Promise<void> {
  button.focus();
  expect(button).toHaveFocus();
  await user.keyboard('[Space]');
  await user.keyboard('[Space>4]');
  await user.keyboard('[/Space]');
}

/** Space as bare events must be cancelled, which is what stops the browser's own press: going down, repeating, and coming up. */
function expectRefused(button: HTMLElement): void {
  expect(fireEvent.keyDown(button, SPACE)).toBe(false);
  expect(fireEvent.keyDown(button, { ...SPACE, repeat: true })).toBe(false);
  expect(fireEvent.keyUp(button, SPACE)).toBe(false);
}

/** The demo's running task, made to be running on Office PC. */
function elsewhere(): MockState {
  const s = demoState();
  const t = s.tasks.find((x) => x.id === 't-logo');
  const open = s.segments.find((x) => x.taskId === 't-logo' && x.end === null);
  if (!t || !open) throw new Error('seed');
  open.deviceId = 'other-device';
  t.runningElsewhere = 'Office PC';
  return s;
}

/** "Email and invoices" left running on Office PC and last heard of two days ago: its time can be closed from the details. */
function abandoned(): MockState {
  const s = demoState();
  const t = s.tasks.find((x) => x.id === 't-mail');
  if (!t) throw new Error('seed');
  t.state = 'running';
  t.pauseReason = null;
  t.runningElsewhere = 'Office PC';
  s.segments.push({ id: 'seg-old', taskId: 't-mail', deviceId: OTHER_DEVICE_ID, start: '2026-03-09T15:20:00Z', end: null, provisionalEnd: '2026-03-10T15:20:00Z' });
  return s;
}

/** The demo after a restart: nothing has started yet, so Resume asks for every field again. */
function coldDemo(): MockState {
  const s = demoState();
  relaunch(s);
  return s;
}

const article = async (name: string) => within(await screen.findByRole('article', { name }));

interface Site {
  name: string;
  start: () => MockState;
  /** The button, once the app has drawn it and any steps before it are done. */
  find: (user: User) => Promise<HTMLElement>;
  /** Nothing the button opens is open. */
  quiet?: () => void;
  /** The button was pressed, once, and what it does has happened. */
  didOnce: () => Promise<void>;
}

const SITES: Site[] = [
  {
    name: 'Start on a task card',
    start: demoState,
    find: async () => (await article('Social templates')).getByRole('button', { name: 'Start' }),
    didOnce: async () => {
      await waitFor(() => expect(calls('start_task')).toEqual([{ id: 't-next' }]));
      await waitFor(() => expect(task('t-next')?.state).toBe('running'));
    },
  },
  {
    name: 'Pause on a task card',
    start: demoState,
    find: async () => (await article('Logo concepts')).getByRole('button', { name: 'Pause' }),
    didOnce: async () => {
      await waitFor(() => expect(calls('pause_task')).toEqual([{ id: 't-logo' }]));
      await waitFor(() => expect(task('t-logo')?.state).toBe('paused'));
    },
  },
  {
    name: 'Resume on a task card',
    start: demoState,
    find: async () => (await article('Brand guidelines')).getByRole('button', { name: 'Resume' }),
    didOnce: async () => {
      await waitFor(() => expect(calls('resume_task')).toEqual([{ id: 't-guide' }]));
      await waitFor(() => expect(task('t-guide')?.state).toBe('running'));
    },
  },
  {
    name: 'Stop on a task card',
    start: demoState,
    find: async () => (await article('Logo concepts')).getByRole('button', { name: 'Stop' }),
    didOnce: async () => {
      await waitFor(() => expect(calls('stop_task')).toEqual([{ id: 't-logo' }]));
      await waitFor(() => expect(task('t-logo')?.state).toBe('stopped'));
    },
  },
  {
    name: 'Resume on a task card after a restart, which opens the form to continue it',
    start: coldDemo,
    find: async () => (await article('Logo concepts')).getByRole('button', { name: 'Resume' }),
    quiet: () => expect(screen.queryByRole('form', { name: 'Continue Logo concepts' })).toBeNull(),
    didOnce: async () => {
      expect(await screen.findByRole('form', { name: 'Continue Logo concepts' })).toBeVisible();
      expect(sent()).toEqual([]);
    },
  },
  {
    name: 'Start in the new task form',
    start: demoState,
    find: async (user) => {
      await user.click(await screen.findByRole('button', { name: 'New task' }));
      return within(screen.getByRole('form', { name: 'New task' })).getByRole('button', { name: 'Start' });
    },
    didOnce: async () => {
      await waitFor(() => expect(calls('start_task')).toHaveLength(1));
      expect(calls('create_task')).toHaveLength(1);
    },
  },
  {
    name: 'Start in the form that continues a task after a restart',
    start: coldDemo,
    find: async (user) => {
      await user.click((await article('Logo concepts')).getByRole('button', { name: 'Resume' }));
      const form = screen.getByRole('form', { name: 'Continue Logo concepts' });
      // Space still types in the text fields of the same form.
      await user.type(within(form).getByRole('textbox', { name: 'Task name' }), 'Logo concepts v2');
      expect(within(form).getByRole('textbox', { name: 'Task name' })).toHaveValue('Logo concepts v2');
      await user.selectOptions(within(form).getByRole('combobox', { name: 'Project' }), 'p-brand');
      await user.type(within(form).getByRole('textbox', { name: 'Description' }), 'Second round');
      await user.click(within(form).getByRole('checkbox', { name: 'Revision' }));
      const start = within(form).getByRole('button', { name: 'Start' });
      expect(start).toBeEnabled();
      return start;
    },
    didOnce: async () => {
      await waitFor(() => expect(calls('start_task')).toHaveLength(1));
      expect(calls('create_task')).toHaveLength(1);
      expect(calls('create_task')[0]).toMatchObject({ input: { name: 'Logo concepts v2', continuedFrom: 't-logo' } });
    },
  },
  {
    name: 'Pause in the forgotten-timer reminder',
    start: () => {
      const s = demoState();
      s.reminderOverride = { kind: 'pastShift', taskId: 't-logo', shift: 'Morning', ended: '2026-03-12T13:00:00Z' };
      return s;
    },
    find: async () => within(await screen.findByTestId('reminder-banner')).getByRole('button', { name: 'Pause' }),
    didOnce: async () => {
      await waitFor(() => expect(calls('pause_task')).toEqual([{ id: 't-logo' }]));
      await waitFor(() => expect(task('t-logo')?.state).toBe('paused'));
    },
  },
  {
    name: 'Pause it from here, on a task running on another computer',
    start: elsewhere,
    find: async () => (await article('Logo concepts')).getByRole('button', { name: /Pause it from here/ }),
    didOnce: async () => {
      await waitFor(() => expect(state.pauseRequests).toHaveLength(1));
      expect(calls('request_remote_pause')).toEqual([{ taskId: 't-logo' }]);
    },
  },
  {
    name: 'Confirm close, which ends time another computer left running',
    start: abandoned,
    find: async (user) => {
      await user.click((await article('Email and invoices')).getByRole('button', { name: 'Details' }));
      const dialog = await screen.findByRole('dialog');
      await user.click(within(dialog).getByRole('tab', { name: 'Corrections' }));
      const row = dialog.querySelector<HTMLElement>('[data-segment-id="seg-old"]');
      if (!row) throw new Error('no row for seg-old');
      await user.click(within(row).getByRole('button', { name: 'Close at last known time' }));
      return within(row).getByRole('button', { name: 'Confirm close' });
    },
    didOnce: async () => {
      await waitFor(() => expect(calls('settle_lost_segment')).toEqual([{ segmentId: 'seg-old', reason: '' }]));
      await waitFor(() => expect(task('t-mail')?.state).toBe('paused'));
    },
  },
];

describe.each(SITES)('$name', (site) => {
  it('ignores Space pressed, held and repeated, and Enter then presses it once', async () => {
    const user = userEvent.setup();
    boot(site.start());
    const button = await site.find(user);
    const [commands, before] = [sent(), world()];
    await pressSpace(user, button);
    expect(sent()).toEqual(commands);
    expect(world()).toBe(before);
    site.quiet?.();
    expect(button).toHaveFocus();
    expectRefused(button);
    await user.keyboard('{Enter}');
    await site.didOnce();
  });

  it('ignores Space the same way, and a click then presses it once', async () => {
    const user = userEvent.setup();
    boot(site.start());
    const button = await site.find(user);
    const [commands, before] = [sent(), world()];
    await pressSpace(user, button);
    expect(sent()).toEqual(commands);
    expect(world()).toBe(before);
    site.quiet?.();
    expect(button).toHaveFocus();
    expectRefused(button);
    await user.click(button);
    await site.didOnce();
  });
});

describe('Space elsewhere is unchanged', () => {
  it('the buttons beside the timer controls still take Space, and the timer controls do not', async () => {
    const user = userEvent.setup();
    boot(demoState());
    const logo = await article('Logo concepts');
    const pause = logo.getByRole('button', { name: 'Pause' });
    await pressSpace(user, pause);
    expect(sent()).toEqual([]);
    expect(task('t-logo')?.state).toBe('running');
    expect(pause).toHaveFocus();
    expectRefused(pause);
    logo.getByRole('button', { name: 'Details' }).focus();
    await user.keyboard('[Space]');
    expect(await screen.findByRole('dialog')).toBeVisible();
  });
});
