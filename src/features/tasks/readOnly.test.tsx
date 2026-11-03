// Tasks while another computer holds the lease (design test 66). The backend refuses every change, and that is the guarantee; the
// page shows it early: controls off with the reason, an editor that can't be typed in, and what was typed kept for after a take over.
import { emit } from '@tauri-apps/api/event';
import { clearMocks } from '@tauri-apps/api/mocks';
import { act, cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { readOnlyMessage } from '../../app/useReadOnly';
import { boot as bootApp, polyfillDom } from '../../components/testKit';
import { api } from '../../lib/api';
import { demoP2State, demoState } from '../../mocks/demoSeed';
import { leaseView, loseLease, seedLease, type LeaseSeed, type MockState } from '../../mocks/ipcMock';
import { AUTOSAVE_MS } from './TaskEditor';

const WHY = readOnlyMessage('LAPTOP');
/** Longer than the five retries of a failing save added up: 2 + 4 + 8 + 16 + 32 seconds. */
const ALL_RETRIES_MS = 70_000;

let state: MockState;
beforeEach(polyfillDom);
afterEach(() => {
  cleanup();
  clearMocks();
});

function boot(s: MockState, lease?: LeaseSeed) {
  state = s;
  if (lease) seedLease(s, lease);
  return bootApp(s);
}
const calls = (cmd: string) => state.calls.filter((c) => c.cmd === cmd).map((c) => c.args as Record<string, unknown>);
const card = async (name: string) => within(await screen.findByRole('article', { name }));
/** Another computer takes the lease, or this one takes it back, and the page hears about it. */
const arrives = (change: () => unknown) =>
  act(async () => {
    await change();
    await emit('state-changed');
  });
/** This computer takes the lease from whoever holds it now, as the dialog's second step does. */
const takeOver = () => {
  const holder = leaseView(state).holder;
  if (!holder) throw new Error('nobody holds the lease');
  return api.leaseTakeOver({ generation: holder.generation, beatSeq: holder.beatSeq }, 'live');
};

describe('Start, Pause, Resume and Stop', () => {
  it('are off while another computer holds the lease, each saying why, and a finished task keeps its own reason', async () => {
    boot(demoState(), 'live');
    const draft = await card('Social templates');
    expect(draft.getByRole('button', { name: 'Start' })).toBeDisabled();
    expect(draft.getByRole('button', { name: 'Start' })).toHaveAttribute('title', WHY);
    expect(draft.getByText(WHY)).toBeVisible();
    const running = await card('Logo concepts');
    expect(running.getByRole('button', { name: 'Pause' })).toBeDisabled();
    expect(running.getByRole('button', { name: 'Pause' })).toHaveAttribute('title', WHY);
    expect(running.getByRole('button', { name: 'Stop' })).toBeDisabled();
    const paused = await card('Brand guidelines');
    expect(paused.getByRole('button', { name: 'Resume' })).toBeDisabled();
    expect(paused.getByRole('button', { name: 'Resume' })).toHaveAttribute('title', WHY);
    const finished = await card('Homepage layout');
    expect(finished.getByRole('button', { name: 'Start' })).toHaveAttribute('title', 'This task is finished.');
  });

  it('send nothing when pressed, and work as they always did with no folder', async () => {
    const user = userEvent.setup();
    boot(demoState(), 'live');
    await user.click((await card('Social templates')).getByRole('button', { name: 'Start' }));
    expect(calls('start_task')).toEqual([]);
    cleanup();
    clearMocks();
    boot(demoState());
    const start = (await card('Social templates')).getByRole('button', { name: 'Start' });
    expect(start).toBeEnabled();
    expect(start).not.toHaveAttribute('title');
  });

  it('are on again after taking over, and off again when another computer takes the lease back', async () => {
    const s = demoState();
    boot(s, 'live');
    const start = async () => (await card('Social templates')).getByRole('button', { name: 'Start' });
    expect(await start()).toBeDisabled();
    await arrives(takeOver);
    await waitFor(async () => expect(await start()).toBeEnabled());
    await arrives(() => loseLease(s));
    await waitFor(async () => expect(await start()).toBeDisabled());
  });

  it('Delete draft is off too, and the dialog it opened says why when the lease goes while it is open', async () => {
    const user = userEvent.setup();
    const s = demoState();
    boot(s, 'mine');
    await user.click(await screen.findByRole('button', { name: 'Delete draft Social templates' }));
    const dialog = await screen.findByRole('dialog', { name: 'Delete this draft?' });
    expect(within(dialog).getByRole('button', { name: 'Delete draft' })).toBeEnabled();
    await arrives(() => loseLease(s));
    await waitFor(() => expect(within(dialog).getByRole('button', { name: 'Delete draft' })).toBeDisabled());
    expect(within(dialog).getByText(WHY)).toBeVisible();
    await user.click(within(dialog).getByRole('button', { name: 'Keep it' }));
    expect(screen.getByRole('button', { name: 'Delete draft Social templates' })).toBeDisabled();
    expect(calls('delete_draft')).toEqual([]);
  });
});

describe('a task running on another computer', () => {
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

  it('can still be asked to pause from a read-only computer: that is what it is for', async () => {
    const user = userEvent.setup();
    boot(elsewhere(), 'live');
    const c = await card('Logo concepts');
    expect(c.getByRole('button', { name: 'Stop' })).toBeDisabled();
    const ask = c.getByRole('button', { name: /Pause it from here/ });
    expect(ask).toBeEnabled();
    await user.click(ask);
    await waitFor(() => expect(state.pauseRequests).toHaveLength(1));
    expect(document.querySelector('.banner-error')).toBeNull();
  });
});

describe('the items of a task list', () => {
  it('can not be made active from a read-only computer', async () => {
    const s = demoP2State();
    boot(s, 'live');
    const c = await card('Logo concepts');
    const make = c.getAllByRole('button', { name: /Make active/ });
    expect(make.length).toBeGreaterThan(0);
    for (const b of make) {
      expect(b).toBeDisabled();
      expect(b).toHaveAttribute('title', WHY);
    }
    expect(c.getByRole('button', { name: 'No subtask' })).toBeDisabled();
  });
});

describe('the editor', () => {
  const form = () => screen.getByRole('form', { name: 'Editing Brand guidelines' });
  const box = () => within(form()).getByRole('textbox', { name: 'Description' });
  const status = () => within(form()).getByTestId('save-state');
  const saved = () => JSON.stringify(state.tasks.find((t) => t.id === 't-guide')?.description);

  it('has nothing to type into while read-only, and says why', async () => {
    const user = userEvent.setup();
    // The p2 demo has tags, and time away that waits for an answer: the dialog for it stays closed meanwhile.
    boot(demoP2State(), 'live');
    await user.click(await screen.findByRole('button', { name: 'Edit Brand guidelines' }));
    const f = within(form());
    expect(f.getByRole('textbox', { name: 'Task name' })).toHaveAttribute('readonly');
    expect(f.getByRole('combobox', { name: 'Project' })).toBeDisabled();
    expect(box()).toHaveAttribute('contenteditable', 'false');
    expect(box()).toHaveAttribute('aria-readonly', 'true');
    for (const b of f.getAllByRole('button', { name: /^(Bold|Italic|Heading \d|Bullet list|Numbered list|Task list)$/ })) expect(b).toBeDisabled();
    for (const tag of f.getAllByRole('checkbox')) expect(tag).toBeDisabled();
    expect(f.getByRole('button', { name: 'Save as template' })).toBeDisabled();
    expect(f.getByRole('button', { name: 'Save as template' })).toHaveAttribute('title', WHY);
    expect(status()).toHaveTextContent(WHY);
    // Done only closes: nothing is unsaved.
    await user.click(f.getByRole('button', { name: 'Done' }));
    await waitFor(() => expect(screen.queryByRole('form', { name: 'Editing Brand guidelines' })).toBeNull());
    expect(calls('patch_task')).toEqual([]);
  });

  it('typing into it changes nothing and sends nothing', async () => {
    const user = userEvent.setup();
    boot(demoState(), 'live');
    await user.click(await screen.findByRole('button', { name: 'Edit Brand guidelines' }));
    await user.click(within(form()).getByRole('textbox', { name: 'Task name' }));
    await user.keyboard('abc');
    await user.click(box());
    await user.keyboard('abc');
    expect(within(form()).getByRole('textbox', { name: 'Task name' })).toHaveValue('Brand guidelines');
    expect(box()).not.toHaveTextContent('abc');
    await new Promise((r) => setTimeout(r, AUTOSAVE_MS + 200));
    expect(calls('patch_task')).toEqual([]);
  });

  it('is editable and saves when this computer may write', async () => {
    const user = userEvent.setup();
    boot(demoState(), 'mine');
    await user.click(await screen.findByRole('button', { name: 'Edit Brand guidelines' }));
    expect(box()).toHaveAttribute('contenteditable', 'true');
    expect(box()).not.toHaveAttribute('aria-readonly');
    expect(within(form()).getByRole('textbox', { name: 'Task name' })).not.toHaveAttribute('readonly');
    expect(within(form()).getByRole('button', { name: 'Save as template' })).toBeEnabled();
    await user.click(box());
    await user.keyboard('Written here');
    await waitFor(() => expect(saved()).toContain('Written here'));
  });

  it('turns editable again when this computer takes over, without being reopened', async () => {
    const user = userEvent.setup();
    boot(demoState(), 'live');
    await user.click(await screen.findByRole('button', { name: 'Edit Brand guidelines' }));
    expect(box()).toHaveAttribute('contenteditable', 'false');
    await arrives(takeOver);
    await waitFor(() => expect(box()).toHaveAttribute('contenteditable', 'true'));
    expect(within(form()).getByRole('combobox', { name: 'Project' })).toBeEnabled();
    expect(status()).not.toHaveTextContent(WHY);
    await user.click(box());
    await user.keyboard('After the take over');
    await waitFor(() => expect(saved()).toContain('After the take over'));
  });

  describe('as another computer takes the lease over words being typed', () => {
    beforeEach(() => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'], shouldAdvanceTime: true });
    });
    afterEach(async () => {
      await act(() => vi.advanceTimersByTimeAsync(ALL_RETRIES_MS));
      vi.useRealTimers();
    });
    const pass = (ms: number) => act(() => vi.advanceTimersByTimeAsync(ms));

    it('keeps the words dirty and shown, says they are not saved, does not try again, and sends them once this computer takes over', async () => {
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime.bind(vi) });
      const s = demoState();
      boot(s, 'mine');
      await user.click(await screen.findByRole('button', { name: 'Edit Brand guidelines' }));
      await user.click(box());
      await user.keyboard(' unsent words');
      // The autosave has not gone yet when LAPTOP takes the lease.
      await arrives(() => loseLease(s));
      await pass(AUTOSAVE_MS + 100);

      await waitFor(() => expect(status()).toHaveTextContent('Not saved: LAPTOP is using zWorkTracker. Take over to save.'));
      expect(status()).toHaveAttribute('data-kind', 'failed');
      const tries = calls('patch_task').length;
      expect(tries).toBeGreaterThan(0);
      expect(saved()).not.toContain('unsent words');
      // Not tried again by itself, however long it waits.
      await pass(ALL_RETRIES_MS);
      expect(calls('patch_task')).toHaveLength(tries);
      // The words are still there, still unsaved, and the draft on disk still holds them (stashing is allowed).
      expect(box()).toHaveTextContent('unsent words');
      expect(box()).toHaveAttribute('contenteditable', 'false');
      expect(JSON.stringify(s.drafts['t-guide'])).toContain('unsent words');

      // Taking over is all that was missing.
      await arrives(takeOver);
      await waitFor(() => expect(saved()).toContain('unsent words'));
      await waitFor(() => expect(status()).toHaveAttribute('data-kind', 'saved'));
      expect(box()).toHaveAttribute('contenteditable', 'true');
      expect(box()).toHaveTextContent('unsent words');
    });

    it('with the editor closed, the words wait in a notice that says why', async () => {
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime.bind(vi) });
      const s = demoState();
      boot(s, 'mine');
      await user.click(await screen.findByRole('button', { name: 'Edit Brand guidelines' }));
      await user.click(box());
      await user.keyboard(' unsent words');
      await arrives(() => loseLease(s));
      await pass(AUTOSAVE_MS + 100);
      await waitFor(() => expect(status()).toHaveAttribute('data-kind', 'failed'));
      await user.click(screen.getByRole('button', { name: 'Edit Brand guidelines' }));
      expect(screen.queryByRole('form', { name: 'Editing Brand guidelines' })).toBeNull();
      const notice = await screen.findByTestId('unsent-banner');
      expect(notice).toHaveTextContent("can't be saved: LAPTOP is using zWorkTracker, so this computer is read-only. Take over from the banner to work here. It is still here.");
    });

    it('R4: with the editor closed, taking over sends the words by itself, and the notice that said to take over goes', async () => {
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime.bind(vi) });
      const s = demoState();
      boot(s, 'mine');
      await user.click(await screen.findByRole('button', { name: 'Edit Brand guidelines' }));
      await user.click(box());
      await user.keyboard(' unsent words');
      await arrives(() => loseLease(s));
      await pass(AUTOSAVE_MS + 100);
      await waitFor(() => expect(status()).toHaveAttribute('data-kind', 'failed'));
      await user.click(screen.getByRole('button', { name: 'Edit Brand guidelines' }));
      expect(screen.queryByRole('form', { name: 'Editing Brand guidelines' })).toBeNull();
      expect(await screen.findByTestId('unsent-banner')).toHaveTextContent('Take over from the banner to work here.');
      expect(saved()).not.toContain('unsent words');

      // Taking over is all that was missing, and there is no editor on screen to notice.
      await arrives(takeOver);
      await waitFor(() => expect(saved()).toContain('unsent words'));
      await waitFor(() => expect(screen.queryByTestId('unsent-banner')).toBeNull());
      // Sent once more, not over and over: the draft is gone with the notice.
      const tries = calls('patch_task').length;
      await pass(ALL_RETRIES_MS);
      expect(calls('patch_task')).toHaveLength(tries);
    });

    it('R4: a change of the lease sends nothing while the other computer still holds it, and words refused for another reason wait as they did', async () => {
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime.bind(vi) });
      const s = demoState();
      boot(s, 'mine');
      await user.click(await screen.findByRole('button', { name: 'Edit Brand guidelines' }));
      await user.click(box());
      await user.keyboard(' unsent words');
      await arrives(() => loseLease(s));
      await pass(AUTOSAVE_MS + 100);
      await waitFor(() => expect(status()).toHaveAttribute('data-kind', 'failed'));
      await user.click(screen.getByRole('button', { name: 'Edit Brand guidelines' }));
      await screen.findByTestId('unsent-banner');
      const tries = calls('patch_task').length;
      // The holder changes (another computer takes over from it) and this one is still read-only: the notice stays, and nothing is sent.
      await arrives(() => loseLease(s, { deviceName: 'DESKTOP', generation: 9 }));
      await pass(AUTOSAVE_MS + 100);
      expect(calls('patch_task')).toHaveLength(tries);
      expect(screen.getByTestId('unsent-banner')).toHaveTextContent('Take over from the banner to work here.');
      expect(saved()).not.toContain('unsent words');
    });
  });
});

describe('the new task form', () => {
  const openForm = async (user: ReturnType<typeof userEvent.setup>) => {
    await user.click(await screen.findByRole('button', { name: 'New task' }));
    return within(screen.getByRole('form', { name: 'New task' }));
  };

  it('can not save while read-only, says why beside the buttons, and sends nothing on Enter', async () => {
    const user = userEvent.setup();
    boot(demoState(), 'live');
    const form = await openForm(user);
    expect(form.getByRole('textbox', { name: 'Task name' })).toHaveValue('Logo concepts');
    expect(form.getByRole('button', { name: 'Save draft' })).toBeDisabled();
    expect(form.getByRole('button', { name: 'Start' })).toBeDisabled();
    expect(form.getByRole('button', { name: 'Start' })).toHaveAccessibleDescription(WHY);
    expect(form.getByRole('status')).toHaveTextContent(WHY);
    await user.type(form.getByRole('textbox', { name: 'Task name' }), ' again{Enter}');
    expect(calls('create_task')).toEqual([]);
    expect(form.getByRole('button', { name: 'Cancel' })).toBeEnabled();
  });

  it('keeps what was typed when the lease goes, and saves it after a take over', async () => {
    const user = userEvent.setup();
    const s = demoState();
    boot(s, 'mine');
    const form = await openForm(user);
    const name = form.getByRole('textbox', { name: 'Task name' });
    await user.clear(name);
    await user.type(name, 'Typed before the lease went');
    expect(form.getByRole('button', { name: 'Save draft' })).toBeEnabled();

    await arrives(() => loseLease(s));
    await waitFor(() => expect(form.getByRole('button', { name: 'Save draft' })).toBeDisabled());
    expect(form.getByRole('textbox', { name: 'Task name' })).toHaveValue('Typed before the lease went');
    expect(form.getByRole('combobox', { name: 'Project' })).toHaveValue('p-brand');
    expect(calls('create_task')).toEqual([]);

    await arrives(takeOver);
    await waitFor(() => expect(form.getByRole('button', { name: 'Save draft' })).toBeEnabled());
    expect(form.queryByRole('status')).toBeNull();
    await user.click(form.getByRole('button', { name: 'Save draft' }));
    await waitFor(() => expect(s.tasks.some((t) => t.name === 'Typed before the lease went')).toBe(true));
  });
});
