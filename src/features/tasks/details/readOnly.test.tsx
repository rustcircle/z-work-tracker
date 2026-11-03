// The details of a task, three ways. Time another computer left running can be closed at its last known time from here (design 5.5),
// and a segment closed that way is an ordinary one to correct or void (5.1). And while another computer holds the lease every
// change is off, with the reason, and what was typed waits for a take over.
import { emit } from '@tauri-apps/api/event';
import { clearMocks } from '@tauri-apps/api/mocks';
import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { readOnlyMessage } from '../../../app/useReadOnly';
import { boot as bootApp, polyfillDom } from '../../../components/testKit';
import { api } from '../../../lib/api';
import { parseIso, toIso } from '../../../lib/tz';
import type { Snapshot } from '../../../lib/types';
import { DEMO_NOW, demoP2State, demoState } from '../../../mocks/demoSeed';
import { OTHER_DEVICE_ID, handle, leaseView, loseLease, seedLease, type LeaseSeed, type MockState } from '../../../mocks/ipcMock';

const WHY = readOnlyMessage('LAPTOP');
const DEFAULT_REASON = 'Closed from Mock PC: Office PC stopped responding. Ended at its last known moment.';
const NOW = parseIso(DEMO_NOW);
const ago = (secs: number): string => toIso(NOW - secs);

let state: MockState;
beforeEach(polyfillDom);
afterEach(() => {
  cleanup();
  clearMocks();
});

/** "Email and invoices" left running on Office PC: started three days ago, last heard of two days ago. */
function abandoned(s: MockState): MockState {
  const t = s.tasks.find((x) => x.id === 't-mail');
  if (!t) throw new Error('no task');
  t.state = 'running';
  t.pauseReason = null;
  t.runningElsewhere = 'Office PC';
  s.segments.push({ id: 'seg-old', taskId: 't-mail', deviceId: OTHER_DEVICE_ID, start: ago(3 * 86_400), end: null, provisionalEnd: ago(2 * 86_400) });
  return s;
}

function boot(s: MockState, lease?: LeaseSeed) {
  state = s;
  if (lease) seedLease(s, lease);
  return bootApp(s);
}
const calls = (cmd: string) => state.calls.filter((c) => c.cmd === cmd).map((c) => c.args as Record<string, unknown>);
const snap = (): Snapshot => handle(state, 'get_snapshot', {}) as Snapshot;
const arrives = (change: () => unknown) =>
  act(async () => {
    await change();
    await emit('state-changed');
  });
const takeOver = () => {
  const holder = leaseView(state).holder;
  if (!holder) throw new Error('nobody holds the lease');
  return api.leaseTakeOver({ generation: holder.generation, beatSeq: holder.beatSeq }, 'live');
};

async function openDetails(user: ReturnType<typeof userEvent.setup>, taskName: string, tab: string) {
  const article = await screen.findByRole('article', { name: taskName });
  await user.click(within(article).getByRole('button', { name: 'Details' }));
  const dialog = await screen.findByRole('dialog');
  await user.click(within(dialog).getByRole('tab', { name: tab }));
  return dialog;
}
const row = (dialog: HTMLElement, id: string): HTMLElement => {
  const li = dialog.querySelector<HTMLElement>(`[data-segment-id="${id}"]`);
  if (!li) throw new Error(`no row for ${id}`);
  return li;
};

describe('time another computer left running', () => {
  it('offers Close at last known time on it, and not on this computer’s own running time', async () => {
    const user = userEvent.setup();
    const s = abandoned(demoState());
    boot(s);
    const dialog = await openDetails(user, 'Email and invoices', 'Corrections');
    const old = within(row(dialog, 'seg-old'));
    expect(old.getByText('Still running. Pause or stop the task before you correct this time.')).toBeVisible();
    expect(old.getByRole('button', { name: 'Close at last known time' })).toBeEnabled();
    expect(old.queryByRole('button', { name: 'Correct' })).toBeNull();
    expect(old.queryByRole('button', { name: 'Void' })).toBeNull();
    await user.click(within(dialog).getByRole('button', { name: 'Close' }));

    const own = await openDetails(user, 'Logo concepts', 'Corrections');
    expect(within(own).getByText('Still running. Pause or stop the task before you correct this time.')).toBeVisible();
    expect(within(own).queryByRole('button', { name: 'Close at last known time' })).toBeNull();
  });

  it('asks first, says what it does and when it works, and sends nothing until confirmed', async () => {
    const user = userEvent.setup();
    boot(abandoned(demoState()));
    const dialog = await openDetails(user, 'Email and invoices', 'Corrections');
    const old = within(row(dialog, 'seg-old'));
    await user.click(old.getByRole('button', { name: 'Close at last known time' }));
    const form = old.getByRole('form', { name: /^Close .* at its last known time$/ });
    // Last heard of two days ago: that is the end it gets, the figure already shown for it.
    expect(form).toHaveTextContent('This ends the time at 15:20, the last moment Office PC is known to have been running it.');
    expect(form).toHaveTextContent('That works once Office PC was asked to pause the task (Pause it from here, on the task), or has said nothing for 24 hours. Before then Office PC may still be running it.');
    expect(form).toHaveTextContent('If Office PC kept working, its own record replaces this when it next syncs, unless the time is already on a billing summary.');
    expect(within(form).getByLabelText('Reason (optional)')).toHaveValue('');
    expect(form).toHaveTextContent('Left blank, the history says: Closed from Mock PC: Office PC stopped responding. Ended at its last known moment.');
    expect(calls('settle_lost_segment')).toEqual([]);
    await user.click(within(form).getByRole('button', { name: 'Cancel' }));
    expect(old.queryByRole('form')).toBeNull();
    expect(calls('settle_lost_segment')).toEqual([]);
  });

  it('closes it at its last known time with the default reason, and the row becomes one that can be corrected', async () => {
    const user = userEvent.setup();
    boot(abandoned(demoState()));
    const dialog = await openDetails(user, 'Email and invoices', 'Corrections');
    const old = within(row(dialog, 'seg-old'));
    await user.click(old.getByRole('button', { name: 'Close at last known time' }));
    await user.click(old.getByRole('button', { name: 'Confirm close' }));
    await waitFor(() => expect(calls('settle_lost_segment')).toEqual([{ segmentId: 'seg-old', reason: '' }]));

    // The recorded end is still missing, and what counts is the settlement. It is no longer "running".
    await waitFor(() => expect(old.queryByText(/Still running/)).toBeNull());
    expect(old.getByText('Counts as').nextElementSibling).toHaveTextContent(/^15:20 to .*15:20/);
    expect(old.getByText('Recorded').nextElementSibling).toHaveTextContent('15:20, no recorded end');
    expect(old.getByText('Recorded').nextElementSibling).not.toHaveTextContent('to now');
    expect(old.getByText('Corrected')).toBeVisible();
    expect(old.getByText(`Reason: ${DEFAULT_REASON}`)).toBeVisible();
    expect(within(dialog).getByText(/^Closed .* at its last known time\. The history says so\.$/)).toBeVisible();
    expect(old.queryByRole('button', { name: 'Close at last known time' })).toBeNull();
    // The task is not running on Office PC any more, and the audit trail says what happened.
    expect(snap().tasks.find((t) => t.id === 't-mail')).toMatchObject({ state: 'paused', runningElsewhere: null });
    await user.click(old.getByRole('button', { name: 'History' }));
    expect(await old.findByText('Closed at its last known time')).toBeVisible();
  });

  it('sends the reason that was typed', async () => {
    const user = userEvent.setup();
    boot(abandoned(demoState()));
    const dialog = await openDetails(user, 'Email and invoices', 'Corrections');
    const old = within(row(dialog, 'seg-old'));
    await user.click(old.getByRole('button', { name: 'Close at last known time' }));
    await user.type(old.getByLabelText('Reason (optional)'), 'The office PC was scrapped');
    await user.click(old.getByRole('button', { name: 'Confirm close' }));
    await waitFor(() => expect(calls('settle_lost_segment')).toEqual([{ segmentId: 'seg-old', reason: 'The office PC was scrapped' }]));
    expect(await old.findByText('Reason: The office PC was scrapped')).toBeVisible();
  });

  it('says in the backend’s words why it can’t yet, keeps the form, and changes nothing', async () => {
    const user = userEvent.setup();
    const s = abandoned(demoState());
    s.remoteDevices = { [OTHER_DEVICE_ID]: { name: 'Office PC', writtenAt: ago(90 * 60) } };
    boot(s);
    const dialog = await openDetails(user, 'Email and invoices', 'Corrections');
    const old = within(row(dialog, 'seg-old'));
    await user.click(old.getByRole('button', { name: 'Close at last known time' }));
    await user.type(old.getByLabelText('Reason (optional)'), 'typed words');
    await user.click(old.getByRole('button', { name: 'Confirm close' }));
    expect(await old.findByRole('alert')).toHaveTextContent('Office PC was seen 1 h 30 min ago, so it may still be running this.');
    expect(old.getByLabelText('Reason (optional)')).toHaveValue('typed words');
    expect(old.getByText('Still running. Pause or stop the task before you correct this time.')).toBeVisible();
    expect(s.segments.find((x) => x.id === 'seg-old')?.edit).toBeFalsy();
    // Typing again clears the refusal; asking Office PC to pause lifts it.
    await user.type(old.getByLabelText('Reason (optional)'), '!');
    expect(old.queryByRole('alert')).toBeNull();
    handle(s, 'request_remote_pause', { taskId: 't-mail' });
    await user.click(old.getByRole('button', { name: 'Confirm close' }));
    await waitFor(() => expect(s.segments.find((x) => x.id === 'seg-old')?.edit).toBeTruthy());
  });
});

describe('time closed from another computer (a settled segment)', () => {
  /** The segment, closed with the backend's own default reason. */
  function settled(): MockState {
    const s = abandoned(demoState());
    handle(s, 'settle_lost_segment', { segmentId: 'seg-old', reason: '' });
    return s;
  }

  it('shows its correction controls, with Void, and not Restore, since it has no recorded end to go back to', async () => {
    const user = userEvent.setup();
    boot(settled());
    const dialog = await openDetails(user, 'Email and invoices', 'Corrections');
    const old = within(row(dialog, 'seg-old'));
    expect(old.queryByText(/Still running/)).toBeNull();
    expect(old.getByRole('button', { name: 'Correct' })).toBeEnabled();
    expect(old.getByRole('button', { name: 'Void' })).toBeEnabled();
    expect(old.queryByRole('button', { name: 'Restore' })).toBeNull();
    expect(old.queryByRole('button', { name: 'Close at last known time' })).toBeNull();
    expect(old.getByText('Recorded').nextElementSibling).toHaveTextContent('15:20, no recorded end');
    // An ordinary segment of the same dialog still has all three.
    const mail = state.segments.find((x) => x.taskId === 't-mail' && x.deviceId !== OTHER_DEVICE_ID && x.end !== null);
    if (!mail) throw new Error('seed');
    const plain = within(row(dialog, mail.id));
    expect(plain.getByRole('button', { name: 'Correct' })).toBeVisible();
    expect(plain.getByRole('button', { name: 'Void' })).toBeVisible();
    expect(plain.queryByRole('button', { name: 'Restore' })).toBeNull();
  });

  it('is corrected like any other time, and the recorded end stays missing', async () => {
    const user = userEvent.setup();
    boot(settled());
    const dialog = await openDetails(user, 'Email and invoices', 'Corrections');
    const old = within(row(dialog, 'seg-old'));
    await user.click(old.getByRole('button', { name: 'Correct' }));
    const form = old.getByRole('form', { name: /^Correct / });
    fireEvent.change(within(form).getByLabelText('New end date'), { target: { value: '2026-03-09' } });
    fireEvent.change(within(form).getByLabelText('New end time'), { target: { value: '17:00' } });
    await user.type(within(form).getByRole('textbox', { name: 'Reason' }), 'Checked with the office');
    await user.click(within(form).getByRole('button', { name: 'Save correction' }));
    await waitFor(() => expect(calls('correct_segment')).toHaveLength(1));
    await waitFor(() => expect(old.getByText('Reason: Checked with the office')).toBeVisible());
    expect(snap().rawSegments.find((x) => x.id === 'seg-old')).toMatchObject({ rawEnd: null, corrected: true, end: '2026-03-09T17:00:00Z' });
  });

  it('is voided, and then only a correction brings it back', async () => {
    const user = userEvent.setup();
    boot(settled());
    const dialog = await openDetails(user, 'Email and invoices', 'Corrections');
    const old = within(row(dialog, 'seg-old'));
    await user.click(old.getByRole('button', { name: 'Void' }));
    await user.type(old.getByRole('textbox', { name: 'Reason' }), 'Not work');
    await user.click(old.getByRole('button', { name: 'Confirm void' }));
    await waitFor(() => expect(old.getByText('Voided')).toBeVisible());
    expect(old.getByText('Counts as').nextElementSibling).toHaveTextContent('Not counted');
    expect(old.getByText('Recorded').nextElementSibling).toHaveTextContent('15:20, no recorded end');
    expect(old.queryByText(/Still running/)).toBeNull();
    // Restore would be refused: there is no recorded end to go back to.
    expect(old.queryByRole('button', { name: 'Restore' })).toBeNull();
    expect(old.getByRole('button', { name: 'Correct' })).toBeEnabled();
  });
});

describe('while another computer holds the lease', () => {
  async function inDetails(user: ReturnType<typeof userEvent.setup>, task: string, tab: string, lease: LeaseSeed = 'live', make: (s: MockState) => MockState = (s) => s) {
    boot(make(demoP2State()), lease);
    // The p2 demo has time away waiting for an answer, which this computer asks about by itself when it may write.
    if (!leaseView(state).readOnly) {
      const away = await screen.findByRole('dialog', { name: /You were away/ });
      await user.keyboard('{Escape}');
      await waitFor(() => expect(away).not.toBeInTheDocument());
    }
    return openDetails(user, task, tab);
  }

  it('Add time can’t be sent: the button is off, the reason is beside it, and Enter in the reason sends nothing', async () => {
    const user = userEvent.setup();
    const dialog = await inDetails(user, 'Homepage layout', 'Add time');
    const form = within(within(dialog).getByRole('form', { name: 'Add time' }));
    expect(form.getByRole('button', { name: 'Add time' })).toBeDisabled();
    expect(form.getByRole('button', { name: 'Add time' })).toHaveAttribute('title', WHY);
    expect(form.getByRole('status')).toHaveTextContent(WHY);
    await user.type(form.getByRole('textbox', { name: 'Reason' }), 'Call with the client{Enter}');
    expect(calls('add_manual_entry')).toEqual([]);
    expect(form.getByRole('textbox', { name: 'Reason' })).toHaveValue('Call with the client');
  });

  it('Add time keeps what was typed when the lease goes, and sends it after a take over', async () => {
    const user = userEvent.setup();
    const dialog = await inDetails(user, 'Homepage layout', 'Add time', 'mine');
    const form = within(within(dialog).getByRole('form', { name: 'Add time' }));
    await user.type(form.getByRole('textbox', { name: 'Reason' }), 'Call with the client');
    fireEvent.change(form.getByLabelText('Start time'), { target: { value: '18:00' } });
    fireEvent.change(form.getByLabelText('End time'), { target: { value: '18:30' } });
    expect(form.getByRole('button', { name: 'Add time' })).toBeEnabled();

    await arrives(() => loseLease(state));
    await waitFor(() => expect(form.getByRole('button', { name: 'Add time' })).toBeDisabled());
    expect(form.getByRole('textbox', { name: 'Reason' })).toHaveValue('Call with the client');
    expect(form.getByLabelText('Start time')).toHaveValue('18:00');

    await arrives(takeOver);
    await waitFor(() => expect(form.getByRole('button', { name: 'Add time' })).toBeEnabled());
    await user.click(form.getByRole('button', { name: 'Add time' }));
    await waitFor(() => expect(calls('add_manual_entry')).toHaveLength(1));
    expect(calls('add_manual_entry')[0]).toMatchObject({ input: { taskId: 't-home', reason: 'Call with the client' } });
  });

  it('Corrections: Correct, Void, Restore and Close at last known time are off, each with the reason', async () => {
    const user = userEvent.setup();
    const dialog = await inDetails(user, 'Email and invoices', 'Corrections', 'live', abandoned);
    expect(within(dialog).getByRole('status')).toHaveTextContent(WHY);
    const old = within(row(dialog, 'seg-old'));
    expect(old.getByRole('button', { name: 'Close at last known time' })).toBeDisabled();
    expect(old.getByRole('button', { name: 'Close at last known time' })).toHaveAttribute('title', WHY);
    const buttons = within(dialog).getAllByRole('button', { name: /^(Correct|Void|Restore)$/ });
    expect(buttons.length).toBeGreaterThan(0);
    for (const b of buttons) {
      expect(b).toBeDisabled();
      expect(b).toHaveAttribute('title', WHY);
    }
  });

  it('Corrections: a Restore on a corrected segment is off too', async () => {
    const user = userEvent.setup();
    const dialog = await inDetails(user, 'Logo concepts', 'Corrections');
    const restore = within(dialog).getByRole('button', { name: 'Restore' });
    expect(restore).toBeDisabled();
    expect(restore).toHaveAttribute('title', WHY);
  });

  it('Corrections: a correction in progress keeps its words when the lease goes, and can be saved after a take over', async () => {
    const user = userEvent.setup();
    const dialog = await inDetails(user, 'Box dieline', 'Corrections', 'mine');
    const rows = within(dialog).getAllByRole('listitem').filter((li) => /Tue 10 Mar 2026.*14:00 to/.test(li.textContent ?? ''));
    const last = rows.at(-1);
    if (!last) throw new Error('no segment row on Tue 10 Mar');
    const target = within(last);
    await user.click(target.getByRole('button', { name: 'Correct' }));
    const form = within(target.getByRole('form', { name: /^Correct / }));
    await user.type(form.getByRole('textbox', { name: 'Reason' }), 'Left early');
    fireEvent.change(form.getByLabelText('New end time'), { target: { value: '16:00' } });

    await arrives(() => loseLease(state));
    await waitFor(() => expect(form.getByRole('button', { name: 'Save correction' })).toBeDisabled());
    expect(form.getByRole('textbox', { name: 'Reason' })).toHaveValue('Left early');
    expect(form.getByLabelText('New end time')).toHaveValue('16:00');
    await user.type(form.getByRole('textbox', { name: 'Reason' }), '{Enter}');
    expect(calls('correct_segment')).toEqual([]);

    await arrives(takeOver);
    await waitFor(() => expect(form.getByRole('button', { name: 'Save correction' })).toBeEnabled());
    await user.click(form.getByRole('button', { name: 'Save correction' }));
    await waitFor(() => expect(calls('correct_segment')).toHaveLength(1));
    expect(calls('correct_segment')[0]).toMatchObject({ input: { reason: 'Left early', end: '2026-03-10T16:00:00Z' } });
  });

  it('Pauses: Bill this pause and Undo are off, and a note typed for a pause stays', async () => {
    const user = userEvent.setup();
    const dialog = await inDetails(user, 'Logo concepts', 'Pauses');
    expect(within(dialog).getByRole('status', {})).toHaveTextContent(WHY);
    const undo = within(dialog).getByRole('button', { name: 'Undo' });
    expect(undo).toBeDisabled();
    expect(undo).toHaveAttribute('title', WHY);
    const bill = within(dialog).getAllByRole('button', { name: 'Bill this pause' });
    expect(bill.length).toBeGreaterThan(0);
    for (const b of bill) expect(b).toBeDisabled();
    const [first] = within(dialog).getAllByRole('textbox', { name: 'Note (optional)' });
    if (!first) throw new Error('no note box on a pause');
    await user.type(first, 'Waiting for the proofs{Enter}');
    expect(first).toHaveValue('Waiting for the proofs');
    expect(calls('mark_billable_pause')).toEqual([]);
  });

  it('Time away: the decisions are off', async () => {
    const user = userEvent.setup();
    const dialog = await inDetails(user, 'Logo concepts', 'Time away');
    expect(within(dialog).getByRole('status', {})).toHaveTextContent(WHY);
    const decisions = within(dialog).getAllByRole('button', { name: /^(Keep|Drop|Mark as thinking)$/ });
    expect(decisions.length).toBeGreaterThan(0);
    for (const b of decisions) {
      expect(b).toBeDisabled();
      expect(b).toHaveAttribute('title', WHY);
    }
    expect(calls('decide_gap')).toEqual([]);
  });

  it('History is still readable', async () => {
    const user = userEvent.setup();
    const dialog = await inDetails(user, 'Logo concepts', 'History');
    expect(await within(dialog).findByRole('list', { name: /history/i })).toBeVisible();
  });

  it('Delete task is off, says why, and the dialog it opened can not go on if the lease goes while it is open', async () => {
    const user = userEvent.setup();
    boot(demoState(), 'mine');
    const article = await screen.findByRole('article', { name: 'Homepage layout' });
    await user.click(within(article).getByRole('button', { name: 'Details' }));
    const dialog = await screen.findByRole('dialog', { name: /^Details/ });
    await user.click(within(dialog).getByRole('button', { name: 'Delete task' }));
    const review = await screen.findByRole('dialog', { name: 'Delete this task?' });
    expect(within(review).getByRole('button', { name: 'Continue' })).toBeDisabled(); // not armed yet

    await arrives(() => loseLease(state));
    await waitFor(() => expect(within(review).getByText(WHY)).toBeVisible());
    await new Promise((r) => setTimeout(r, 1100));
    expect(within(review).getByRole('button', { name: 'Continue' })).toBeDisabled();
    await user.click(within(review).getByRole('button', { name: 'Keep it' }));
    expect(within(dialog).getByRole('button', { name: 'Delete task' })).toBeDisabled();
    expect(within(dialog).getByTestId('delete-read-only')).toHaveTextContent(WHY);
    expect(within(dialog).queryByText(/You are asked twice/)).toBeNull();
    expect(calls('delete_task')).toEqual([]);
  });
});
