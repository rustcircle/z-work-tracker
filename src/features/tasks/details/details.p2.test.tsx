import { clearMocks } from '@tauri-apps/api/mocks';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { boot as bootApp, polyfillDom } from '../../../components/testKit';
import { demoP2State } from '../../../mocks/demoSeed';
import { handle, type MockState } from '../../../mocks/ipcMock';
import type { Snapshot } from '../../../lib/types';

beforeEach(polyfillDom);
afterEach(() => clearMocks());

// The demo's active zone is Lisbon, which is UTC+0 until 29 March, so wall times read as UTC.
let state: MockState;
const boot = (s: MockState) => {
  state = s;
  return bootApp(s);
};
const snap = (): Snapshot => handle(state, 'get_snapshot', {}) as Snapshot;
const calls = (cmd: string) => state.calls.filter((c) => c.cmd === cmd).map((c) => c.args as Record<string, unknown>);

/** The p2 seed has pending time away, so the time-away dialog opens on load. These tests are about Details: dismiss it. */
async function dismissAway(user: ReturnType<typeof userEvent.setup>) {
  await screen.findByRole('article', { name: 'Logo concepts' });
  let away: HTMLElement;
  try {
    away = await screen.findByRole('dialog', { name: /You were away/ }, { timeout: 600 });
  } catch {
    return; // this store has no pending time away
  }
  await user.keyboard('{Escape}');
  await waitFor(() => expect(away).not.toBeInTheDocument());
}

async function openDetails(user: ReturnType<typeof userEvent.setup>, taskName: string, tab?: string) {
  await dismissAway(user);
  const article = await screen.findByRole('article', { name: taskName });
  await user.click(within(article).getByRole('button', { name: 'Details' }));
  const dialog = await screen.findByRole('dialog');
  if (tab) await user.click(within(dialog).getByRole('tab', { name: tab }));
  return dialog;
}

function setWall(dialog: HTMLElement, prefix: string, day: string, time: string) {
  fireEvent.change(within(dialog).getByLabelText(`${prefix} date`), { target: { value: day } });
  fireEvent.change(within(dialog).getByLabelText(`${prefix} time`), { target: { value: time } });
}

const rowWith = (dialog: HTMLElement, text: string | RegExp): HTMLElement => {
  const rows = within(dialog).getAllByRole('listitem').filter((li) => (typeof text === 'string' ? li.textContent?.includes(text) : text.test(li.textContent ?? '')));
  const row = rows[rows.length - 1]; // innermost match
  if (!row) throw new Error(`no row with ${String(text)}`);
  return row;
};

describe('the Details button', () => {
  it('is on started tasks and not on a draft, and opens a labelled dialog on Add time', async () => {
    const user = userEvent.setup();
    boot(demoP2State());
    const draft = await screen.findByRole('article', { name: 'Social templates' });
    expect(within(draft).queryByRole('button', { name: 'Details' })).toBeNull();
    const dialog = await openDetails(user, 'Homepage layout');
    expect(within(dialog).getByRole('heading', { name: 'Details: Homepage layout' })).toBeVisible();
    expect(within(dialog).getByRole('tab', { name: 'Add time', selected: true })).toBeVisible();
    expect(within(dialog).getAllByRole('tab').map((t) => t.textContent)).toEqual(['Add time', 'Corrections', 'History', 'Pauses', 'Time away']);
  });

  it('moves focus in, switches tabs with the arrow keys, closes on Escape and returns focus to the button', async () => {
    const user = userEvent.setup();
    boot(demoP2State());
    await dismissAway(user);
    const article = await screen.findByRole('article', { name: 'Homepage layout' });
    const button = within(article).getByRole('button', { name: 'Details' });
    button.focus();
    await user.keyboard('{Enter}');
    const dialog = await screen.findByRole('dialog');
    await waitFor(() => expect(within(dialog).getByRole('tab', { name: 'Add time' })).toHaveFocus());
    await user.keyboard('{ArrowRight}');
    expect(within(dialog).getByRole('tab', { name: 'Corrections', selected: true })).toHaveFocus();
    await user.keyboard('{End}');
    expect(within(dialog).getByRole('tab', { name: 'Time away', selected: true })).toHaveFocus();
    await user.keyboard('{ArrowRight}');
    expect(within(dialog).getByRole('tab', { name: 'Add time', selected: true })).toHaveFocus();
    // Tab leaves the tab list for the panel, never out of the dialog.
    await user.tab();
    expect(dialog.contains(document.activeElement)).toBe(true);
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(button).toHaveFocus();
  });
});

describe('Add time', () => {
  it('adds a manual entry in the active zone with the reason, and says so', async () => {
    const user = userEvent.setup();
    boot(demoP2State());
    const dialog = await openDetails(user, 'Homepage layout');
    setWall(dialog, 'Start', '2026-03-11', '18:00');
    setWall(dialog, 'End', '2026-03-11', '18:30');
    await user.type(within(dialog).getByRole('textbox', { name: 'Reason' }), 'Phone call with the client');
    await user.click(within(dialog).getByRole('button', { name: 'Add time' }));
    expect(await within(dialog).findByText(/Added 30m to this task/)).toBeVisible();
    expect(calls('add_manual_entry')).toEqual([{ input: { taskId: 't-home', start: '2026-03-11T18:00:00Z', end: '2026-03-11T18:30:00Z', reason: 'Phone call with the client', subtaskId: null, allowOverlap: false } }]);
    expect(snap().rawSegments.some((s) => s.manual && s.start === '2026-03-11T18:00:00Z' && s.reason === '')).toBe(true);
    expect(within(dialog).getByRole('textbox', { name: 'Reason' })).toHaveValue('');
  });

  it('converts wall time with the zone in force: New York in summer is UTC-4', async () => {
    const user = userEvent.setup();
    const s = demoP2State();
    s.settings.activeZone = 'America/New_York';
    boot(s);
    const dialog = await openDetails(user, 'Homepage layout');
    setWall(dialog, 'Start', '2026-03-11', '14:00'); // EDT began on 8 March: UTC-4, so 18:00Z
    setWall(dialog, 'End', '2026-03-11', '14:30');
    await user.type(within(dialog).getByRole('textbox', { name: 'Reason' }), 'x');
    await user.click(within(dialog).getByRole('button', { name: 'Add time' }));
    await within(dialog).findByText(/Added 30m/);
    expect(calls('add_manual_entry')[0]).toMatchObject({ input: { start: '2026-03-11T18:00:00Z', end: '2026-03-11T18:30:00Z' } });
  });

  it('warns about an overlap, sends nothing extra until Add anyway, then resends with allowOverlap', async () => {
    const user = userEvent.setup();
    boot(demoP2State());
    const dialog = await openDetails(user, 'Homepage layout');
    setWall(dialog, 'Start', '2026-03-11', '15:00'); // inside Homepage layout 14:00-16:30
    setWall(dialog, 'End', '2026-03-11', '15:30');
    await user.type(within(dialog).getByRole('textbox', { name: 'Reason' }), 'Forgot to log a second job');
    await user.click(within(dialog).getByRole('button', { name: 'Add time' }));
    const alert = await within(dialog).findByRole('alert');
    expect(alert).toHaveTextContent(/overlaps time already logged on/i);
    expect(alert).toHaveTextContent('Homepage layout');
    expect(state.segments.some((s) => s.manual && s.start === '2026-03-11T15:00:00Z')).toBe(false);
    await user.click(within(alert).getByRole('button', { name: 'Add anyway' }));
    expect(await within(dialog).findByText(/Added 30m/)).toBeVisible();
    expect(calls('add_manual_entry').map((c) => (c.input as { allowOverlap: boolean }).allowOverlap)).toEqual([false, true]);
    expect(within(dialog).queryByRole('button', { name: 'Add anyway' })).toBeNull();
  });

  it('shows an end in the future inline, with no Add anyway, and changes nothing', async () => {
    const user = userEvent.setup();
    boot(demoP2State());
    const dialog = await openDetails(user, 'Homepage layout');
    setWall(dialog, 'Start', '2026-03-12', '15:00');
    setWall(dialog, 'End', '2026-03-12', '16:00'); // now is 15:20
    await user.type(within(dialog).getByRole('textbox', { name: 'Reason' }), 'Later today');
    const before = state.segments.length;
    await user.click(within(dialog).getByRole('button', { name: 'Add time' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent("The end can't be in the future.");
    expect(within(dialog).queryByRole('button', { name: 'Add anyway' })).toBeNull();
    expect(state.segments).toHaveLength(before);
  });

  it('needs a reason and refuses a time clocks skip, without calling the backend', async () => {
    const user = userEvent.setup();
    boot(demoP2State());
    const dialog = await openDetails(user, 'Homepage layout');
    setWall(dialog, 'Start', '2026-03-11', '18:00');
    setWall(dialog, 'End', '2026-03-11', '18:30');
    await user.click(within(dialog).getByRole('button', { name: 'Add time' }));
    expect(await within(dialog).findByText('Say why, so the history makes sense later.')).toBeVisible();
    setWall(dialog, 'Start', '2026-03-29', '01:30'); // Lisbon clocks jump 01:00 to 02:00
    await user.type(within(dialog).getByRole('textbox', { name: 'Reason' }), 'x');
    await user.click(within(dialog).getByRole('button', { name: 'Add time' }));
    expect(await within(dialog).findByText(/does not exist in this zone on 2026-03-29: clocks jump from 01:00 to 02:00/)).toBeVisible();
    expect(calls('add_manual_entry')).toEqual([]);
  });

  it('asks which one when a wall time happens twice', async () => {
    const user = userEvent.setup();
    boot(demoP2State());
    const dialog = await openDetails(user, 'Homepage layout');
    setWall(dialog, 'Start', '2026-10-25', '01:30');
    const choice = await within(dialog).findByRole('combobox', { name: /Start happens twice/ });
    expect(within(choice).getAllByRole('option').map((o) => o.textContent)).toEqual(['01:30 WEST, UTC+1 (first)', '01:30 WET, UTC+0 (second)']);
  });

  it('offers a subtask choice only when the task has subtasks, and sends it', async () => {
    const user = userEvent.setup();
    boot(demoP2State());
    let dialog = await openDetails(user, 'Homepage layout');
    expect(within(dialog).queryByRole('combobox', { name: 'Subtask (optional)' })).toBeNull();
    await user.click(within(dialog).getByRole('button', { name: 'Close' }));
    dialog = await openDetails(user, 'Logo concepts');
    setWall(dialog, 'Start', '2026-03-12', '12:00');
    setWall(dialog, 'End', '2026-03-12', '12:30');
    await user.selectOptions(within(dialog).getByRole('combobox', { name: 'Subtask (optional)' }), 'st-final');
    await user.type(within(dialog).getByRole('textbox', { name: 'Reason' }), 'Artwork');
    await user.click(within(dialog).getByRole('button', { name: 'Add time' }));
    await within(dialog).findByText(/Added 30m/);
    expect(calls('add_manual_entry')[0]).toMatchObject({ input: { subtaskId: 'st-final' } });
  });
});

describe('Corrections', () => {
  it('shows what counts beside what was recorded, and marks corrected, hand-added and running time', async () => {
    const user = userEvent.setup();
    boot(demoP2State());
    let dialog = await openDetails(user, 'Logo concepts', 'Corrections');
    const corrected = rowWith(dialog, 'Corrected');
    expect(within(corrected).getByText('Counts as').nextElementSibling).toHaveTextContent('09:00 to 11:05');
    expect(within(corrected).getByText('Recorded').nextElementSibling).toHaveTextContent('09:00 to 11:20');
    expect(corrected).toHaveTextContent('Reason: Stopped at 11:05, the timer ran on');
    const running = rowWith(dialog, 'to now');
    expect(running).toHaveTextContent('Still running. Pause or stop the task before you correct this time.');
    expect(within(running).queryByRole('button', { name: 'Correct' })).toBeNull();
    await user.click(within(dialog).getByRole('button', { name: 'Close' }));
    dialog = await openDetails(user, 'Homepage layout', 'Corrections');
    expect(rowWith(dialog, 'Added by hand')).toHaveTextContent('16:45 to 17:15');
  });

  it('corrects a time with a reason, keeping the recorded time visible', async () => {
    const user = userEvent.setup();
    boot(demoP2State());
    const dialog = await openDetails(user, 'Box dieline', 'Corrections');
    const row = rowWith(dialog, /Tue 10 Mar 2026.*14:00 to/);
    await user.click(within(row).getByRole('button', { name: 'Correct' }));
    const form = within(row).getByRole('form', { name: /^Correct / });
    fireEvent.change(within(form).getByLabelText('New end time'), { target: { value: '16:00' } });
    await user.click(within(form).getByRole('button', { name: 'Save correction' }));
    expect(await within(form).findByText('Say why, so the history makes sense later.')).toBeVisible();
    await user.type(within(form).getByRole('textbox', { name: 'Reason' }), 'Left early');
    await user.click(within(form).getByRole('button', { name: 'Save correction' }));
    await waitFor(() => expect(snap().rawSegments.some((s) => s.corrected && s.reason === 'Left early')).toBe(true));
    const done = snap().rawSegments.find((s) => s.reason === 'Left early');
    expect(done).toMatchObject({ end: expect.stringContaining('T16:00:00Z'), rawEnd: expect.stringContaining('T16:30:00Z') });
    const after = rowWith(dialog, 'Corrected');
    expect(after).toHaveTextContent('Recorded14:00 to 16:30');
    expect(within(after).getByText('Counts as').nextElementSibling).toHaveTextContent('14:00 to 16:00');
  });

  it('offers Correct anyway when the new time overlaps other logged time', async () => {
    const user = userEvent.setup();
    boot(demoP2State());
    const dialog = await openDetails(user, 'Homepage layout', 'Corrections');
    const row = rowWith(dialog, /Wed 11 Mar 2026.*14:00 to 16:30/);
    await user.click(within(row).getByRole('button', { name: 'Correct' }));
    const form = within(row).getByRole('form', { name: /^Correct / });
    fireEvent.change(within(form).getByLabelText('New end time'), { target: { value: '17:10' } }); // runs into the email work at 17:00
    await user.type(within(form).getByRole('textbox', { name: 'Reason' }), 'Ran over');
    await user.click(within(form).getByRole('button', { name: 'Save correction' }));
    const alert = await within(form).findByRole('alert');
    expect(alert).toHaveTextContent(/overlaps time already logged on/i);
    await user.click(within(alert).getByRole('button', { name: 'Correct anyway' }));
    await waitFor(() => expect(calls('correct_segment')).toHaveLength(2));
    expect(calls('correct_segment').map((c) => (c.input as { allowOverlap: boolean }).allowOverlap)).toEqual([false, true]);
  });

  it('voids with a reason, shows it as not counted beside the recorded time, then restores it', async () => {
    const user = userEvent.setup();
    boot(demoP2State());
    const dialog = await openDetails(user, 'Homepage layout', 'Corrections');
    let row = rowWith(dialog, 'Added by hand');
    await user.click(within(row).getByRole('button', { name: 'Void' }));
    let form = within(row).getByRole('form', { name: /^Void / });
    await user.click(within(form).getByRole('button', { name: 'Confirm void' }));
    expect(await within(form).findByText('Say why, so the history makes sense later.')).toBeVisible();
    expect(calls('void_segment')).toEqual([]);
    await user.type(within(form).getByRole('textbox', { name: 'Reason' }), 'Entered twice');
    await user.click(within(form).getByRole('button', { name: 'Confirm void' }));
    await waitFor(() => expect(calls('void_segment')).toEqual([{ id: expect.any(String), reason: 'Entered twice' }]));
    row = await waitFor(() => rowWith(dialog, 'Voided'));
    expect(within(row).getByText('Counts as').nextElementSibling).toHaveTextContent('Not counted');
    expect(within(row).getByText('Recorded').nextElementSibling).toHaveTextContent('16:45 to 17:15');
    expect(within(row).queryByRole('button', { name: 'Void' })).toBeNull();
    expect(within(row).queryByRole('button', { name: 'Correct' })).toBeNull();

    await user.click(within(row).getByRole('button', { name: 'Restore' }));
    form = within(row).getByRole('form', { name: /^Restore / });
    await user.type(within(form).getByRole('textbox', { name: 'Reason' }), 'It was real after all');
    await user.click(within(form).getByRole('button', { name: 'Confirm restore' }));
    await waitFor(() => expect(calls('restore_segment')).toHaveLength(1));
    await waitFor(() => expect(snap().rawSegments.filter((s) => s.voided)).toEqual([]));
    expect(within(dialog).getByText(/Restored .* to the recorded time/)).toBeVisible();
  });

  it('a billed row says why it cannot change and offers no action; the backend refusal would be shown too', async () => {
    const user = userEvent.setup();
    const s = demoP2State();
    boot(s);
    const dialog = await openDetails(user, 'Homepage layout', 'Corrections');
    const billed = within(dialog).getAllByRole('listitem').filter((li) => li.querySelector('.badge-success')?.textContent === 'Billed');
    expect(billed.length).toBeGreaterThan(0);
    for (const row of billed) {
      expect(row).toHaveTextContent('This time is on a billing summary; void that summary first.');
      expect(within(row).queryByRole('button', { name: /^(Correct|Void|Restore)$/ })).toBeNull();
    }
    // An unbilled row of the same task still has its actions.
    expect(within(rowWith(dialog, 'Added by hand')).getByRole('button', { name: 'Correct' })).toBeVisible();
    // The page can be stale: the backend's conflict is shown safely, as text.
    const target = snap().rawSegments.find((x) => x.manual);
    if (!target) throw new Error('no manual row');
    state.summaries.push({ id: 'late', reference: 'A-009', prefix: 'A', number: 9, deviceId: 'd', projectId: 'p-web', from: '2026-03-11', to: '2026-03-11', zone: 'UTC', createdAt: '2026-03-12T10:00:00Z', segmentIds: [target.id], pauseIds: [], rows: [], totals: {}, voided: false, stamp: { at: '', by: '' } });
    const row = rowWith(dialog, 'Added by hand');
    await user.click(within(row).getByRole('button', { name: 'Void' }));
    const form = within(row).getByRole('form', { name: /^Void / });
    await user.type(within(form).getByRole('textbox', { name: 'Reason' }), 'x');
    await user.click(within(form).getByRole('button', { name: 'Confirm void' }));
    expect(await within(form).findByRole('alert')).toHaveTextContent('This time is on a billing summary; void that summary first.');
  });
});

describe('History', () => {
  it('lists the task entries in plain words, with reasons and before and after, and none of other tasks', async () => {
    const user = userEvent.setup();
    boot(demoP2State());
    let dialog = await openDetails(user, 'Logo concepts', 'History');
    const list = await within(dialog).findByRole('list', { name: 'History of this task' });
    const items = within(list).getAllByRole('listitem');
    const corrected = items.find((li) => li.textContent?.includes('Time corrected'));
    expect(corrected).toHaveTextContent('Time on 9 Mar 09:00 to 11:20');
    expect(corrected).toHaveTextContent('9 Mar 09:00 to 11:20 became 9 Mar 09:00 to 11:05');
    expect(corrected).toHaveTextContent('Reason: Stopped at 11:05, the timer ran on');
    expect(items.some((li) => li.textContent?.includes('Forgot to start the timer after the call'))).toBe(false); // that is Homepage layout
    expect(items.some((li) => li.textContent?.includes('Pause billed'))).toBe(true);
    await user.click(within(dialog).getByRole('button', { name: 'Close' }));
    dialog = await openDetails(user, 'Homepage layout', 'History');
    const home = await within(dialog).findByRole('list', { name: 'History of this task' });
    expect(within(home).getByText('Time added by hand')).toBeVisible();
    expect(home).toHaveTextContent('Reason: Forgot to start the timer after the call');
    expect(home).not.toHaveTextContent('Stopped at 11:05');
  });

  it('shows the history of one segment on its row, and a new entry appears after a change', async () => {
    const user = userEvent.setup();
    boot(demoP2State());
    const dialog = await openDetails(user, 'Homepage layout', 'Corrections');
    const row = rowWith(dialog, 'Added by hand');
    await user.click(within(row).getByRole('button', { name: 'History' }));
    const segList = await within(row).findByRole('list', { name: /^History of / });
    expect(within(segList).getAllByRole('listitem')).toHaveLength(1);
    await user.click(within(row).getByRole('button', { name: 'Void' }));
    const form = within(row).getByRole('form', { name: /^Void / });
    await user.type(within(form).getByRole('textbox', { name: 'Reason' }), 'Entered twice');
    await user.click(within(form).getByRole('button', { name: 'Confirm void' }));
    await waitFor(() => expect(calls('void_segment')).toHaveLength(1));
    const again = await waitFor(() => rowWith(dialog, 'Voided'));
    await user.click(within(again).getByRole('button', { name: 'History' }));
    const after = await within(again).findByRole('list', { name: /^History of / });
    await waitFor(() => expect(within(after).getAllByRole('listitem')).toHaveLength(2));
    expect(after).toHaveTextContent('Time voided');
  });
});

describe('History after changes in the other tabs', () => {
  it('records a time away decision, a billed pause and an undone pause, for this task', async () => {
    const user = userEvent.setup();
    boot(demoP2State());
    const dialog = await openDetails(user, 'Homepage layout', 'Time away');
    await user.click(within(rowWith(dialog, '10:00 to 10:20')).getByRole('button', { name: 'Keep' }));
    await waitFor(() => expect(calls('decide_gap')).toHaveLength(1));
    await user.click(within(dialog).getByRole('tab', { name: 'Pauses' }));
    await user.click(within(rowWith(dialog, /Tue 3 Mar 2026.*11:20 to 11:35/)).getByRole('button', { name: 'Bill this pause' }));
    await waitFor(() => expect(calls('mark_billable_pause')).toHaveLength(1));
    await user.click(await waitFor(() => within(rowWith(dialog, /Tue 3 Mar 2026.*11:20 to 11:35/)).getByRole('button', { name: 'Undo' })));
    await waitFor(() => expect(calls('unmark_billable_pause')).toHaveLength(1));
    await user.click(within(dialog).getByRole('tab', { name: 'History' }));
    const list = await within(dialog).findByRole('list', { name: 'History of this task' });
    await waitFor(() => expect(within(list).getByText('Pause no longer billed')).toBeVisible());
    expect(within(list).getByText('Pause billed')).toBeVisible();
    const decision = within(list).getByText('Time away decision').closest('li');
    expect(decision).toHaveTextContent('dropped became kept');
    expect(decision).toHaveTextContent('Time away 10 Mar 10:00 to 10:20');
  });
});

describe('Pauses', () => {
  // Homepage layout worked 09:00-11:20 and 11:35-12:50 on 3 Mar: one 15 minute pause.
  const pauseRow = (dialog: HTMLElement) => rowWith(dialog, /Tue 3 Mar 2026.*11:20 to 11:35/);

  it('lists the gaps between segments with day and length, and the billable pause time', async () => {
    const user = userEvent.setup();
    boot(demoP2State());
    const dialog = await openDetails(user, 'Homepage layout', 'Pauses');
    const row = pauseRow(dialog);
    expect(row).toHaveTextContent('Tue 3 Mar 2026');
    expect(row).toHaveTextContent('15m');
    expect(within(dialog).getByText(/Billable pause time on this task:/)).toHaveTextContent('0s');
    expect(within(dialog).getByText(/counts in Billable but not in Exact/)).toBeVisible();
  });

  it('keeps gaps between days out of the way until asked, but always lists a billed one', async () => {
    const user = userEvent.setup();
    const s = demoP2State();
    handle(s, 'mark_billable_pause', { input: { taskId: 't-home', start: '2026-03-03T13:00:00Z', end: '2026-03-04T08:00:00Z', note: 'Waiting a night' } });
    boot(s);
    const dialog = await openDetails(user, 'Homepage layout', 'Pauses');
    const list = within(dialog).getByRole('list', { name: 'Pauses' });
    const overnight = within(list).getAllByRole('listitem').filter((li) => /Wed 4 Mar 2026|to Wed 4 Mar/.test(li.textContent ?? ''));
    expect(overnight.map((li) => li.textContent)).toEqual([expect.stringContaining('Waiting a night')]); // the marked one only
    expect(within(list).queryByText(/Fri 6 Mar 2026 to Tue 10 Mar 2026/)).toBeNull();
    await user.click(within(dialog).getByRole('button', { name: /^Show \d+ gaps between days$/ }));
    expect(within(list).getByText(/Fri 6 Mar 2026 to Tue 10 Mar 2026/)).toBeVisible();
    await user.click(within(dialog).getByRole('button', { name: 'Hide gaps between days' }));
    expect(within(list).queryByText(/Fri 6 Mar 2026 to Tue 10 Mar 2026/)).toBeNull();
  });

  it('bills a pause with a note, shows Billed as pause with the note, then undoes it', async () => {
    const user = userEvent.setup();
    boot(demoP2State());
    const dialog = await openDetails(user, 'Homepage layout', 'Pauses');
    let row = pauseRow(dialog);
    await user.type(within(row).getByRole('textbox'), 'Waiting for the client');
    await user.click(within(row).getByRole('button', { name: 'Bill this pause' }));
    await waitFor(() => expect(calls('mark_billable_pause')).toEqual([{ input: { taskId: 't-home', start: '2026-03-03T11:20:00Z', end: '2026-03-03T11:35:00Z', note: 'Waiting for the client' } }]));
    row = await waitFor(() => {
      const r = pauseRow(dialog);
      expect(r).toHaveTextContent('Billed as pause');
      return r;
    });
    expect(row).toHaveTextContent('Note: Waiting for the client');
    expect(within(dialog).getByText(/Billable pause time on this task:/)).toHaveTextContent('15m');
    expect(snap().tasks.find((t) => t.id === 't-home')?.pauseSecs).toBe(900);

    await user.click(within(row).getByRole('button', { name: 'Undo' }));
    await waitFor(() => expect(calls('unmark_billable_pause')).toHaveLength(1));
    await waitFor(() => expect(pauseRow(dialog)).not.toHaveTextContent('Billed as pause'));
    expect(within(pauseRow(dialog)).getByRole('button', { name: 'Bill this pause' })).toBeVisible();
    expect(snap().tasks.find((t) => t.id === 't-home')?.pauseSecs).toBe(0);
  });

  it('a pause already marked shows its note from the start, and one on a billing summary shows why it cannot change', async () => {
    const user = userEvent.setup();
    const s = demoP2State();
    const made = handle(s, 'mark_billable_pause', { input: { taskId: 't-home', start: '2026-03-03T11:20:00Z', end: '2026-03-03T11:35:00Z', note: 'On hold' } }) as { id: string };
    handle(s, 'create_summary', { request: { projectId: 'p-web', from: '2026-03-03', to: '2026-03-03', zone: 'Europe/Lisbon' } });
    boot(s);
    const dialog = await openDetails(user, 'Homepage layout', 'Pauses');
    const row = pauseRow(dialog);
    expect(row).toHaveTextContent('Billed as pause');
    expect(row).toHaveTextContent('Note: On hold');
    expect(row).toHaveTextContent('This time is on a billing summary; void that summary first.');
    expect(within(row).queryByRole('button', { name: 'Undo' })).toBeNull();
    expect(made.id).toBeTruthy();
  });

  it('keeps a marked pause reachable when it no longer matches a gap', async () => {
    const user = userEvent.setup();
    const s = demoP2State();
    handle(s, 'mark_billable_pause', { input: { taskId: 't-home', start: '2026-03-03T10:00:00Z', end: '2026-03-03T10:30:00Z', note: 'Orphan' } });
    boot(s);
    const dialog = await openDetails(user, 'Homepage layout', 'Pauses');
    const section = within(dialog).getByRole('region', { name: 'Billed pauses outside the gaps' });
    expect(section).toHaveTextContent('Note: Orphan');
    await user.click(within(section).getByRole('button', { name: 'Undo' }));
    await waitFor(() => expect(within(dialog).queryByRole('region', { name: 'Billed pauses outside the gaps' })).toBeNull());
  });
});

describe('Time away', () => {
  it('lists the task time away with kind, length and decision, and the unconfirmed note', async () => {
    const user = userEvent.setup();
    boot(demoP2State());
    const dialog = await openDetails(user, 'Logo concepts', 'Time away');
    expect(within(dialog).getByText(/Unconfirmed: not counted until you confirm\./)).toBeVisible();
    const row = rowWith(dialog, '14:20 to 14:50');
    expect(row).toHaveTextContent('30m');
    expect(row).toHaveTextContent('Idle');
    expect(row).toHaveTextContent('Waiting for your decision');
    expect(within(dialog).getByRole('list', { name: 'Time away' })).toBeVisible();
    expect(within(row).getAllByRole('button').map((b) => b.textContent)).toEqual(['Keep', 'Drop', 'Mark as thinking']);
  });

  it('words a locked screen in the task details', async () => {
    const user = userEvent.setup();
    const s = demoP2State();
    const locked = s.gaps.find((g) => g.id === 'gap-pending');
    if (!locked) throw new Error('no pending gap in the seed');
    locked.kind = 'lock';
    boot(s);
    const dialog = await openDetails(user, 'Logo concepts', 'Time away');
    const row = rowWith(dialog, '14:20 to 14:50');
    expect(row).toHaveTextContent('Screen locked');
    expect(row).not.toHaveTextContent('Idle');
  });

  it('changes a decision later: unconfirmed drops to zero and thinking time grows', async () => {
    const user = userEvent.setup();
    boot(demoP2State());
    const dialog = await openDetails(user, 'Logo concepts', 'Time away');
    const logo = () => snap().tasks.find((t) => t.id === 't-logo');
    expect(logo()?.unconfirmedSecs).toBe(1800);
    const thinkingBefore = logo()?.thinkingSecs ?? 0;
    let row = rowWith(dialog, '14:20 to 14:50');
    await user.click(within(row).getByRole('button', { name: 'Mark as thinking' }));
    await waitFor(() => expect(calls('decide_gap')).toEqual([{ id: 'gap-pending', decision: 'thinking' }]));
    await waitFor(() => expect(logo()?.unconfirmedSecs).toBe(0));
    expect(logo()?.thinkingSecs).toBe(thinkingBefore + 1800);
    row = rowWith(dialog, '14:20 to 14:50');
    expect(row).toHaveTextContent('Thinking time');
    expect(within(row).getByRole('button', { name: 'Mark as thinking' })).toBeDisabled();
    expect(within(dialog).queryByText(/Unconfirmed: not counted until you confirm\./)).toBeNull();

    await user.click(within(row).getByRole('button', { name: 'Drop' }));
    await waitFor(() => expect(logo()?.thinkingSecs).toBe(thinkingBefore));
    expect(rowWith(dialog, '14:20 to 14:50')).toHaveTextContent('Dropped');
    await user.click(within(rowWith(dialog, '14:20 to 14:50')).getByRole('button', { name: 'Keep' }));
    await waitFor(() => expect(snap().gaps.find((g) => g.id === 'gap-pending')?.decision).toBe('keep'));
    expect(calls('decide_gap').map((c) => c.decision)).toEqual(['thinking', 'drop', 'keep']);
  });

  it('time away on billed time shows why it cannot change', async () => {
    const user = userEvent.setup();
    const s = demoP2State();
    const billedSeg = snap_(s).rawSegments.find((x) => x.taskId === 't-home' && x.billed);
    if (!billedSeg) throw new Error('no billed segment in the demo');
    s.gaps.push({ id: 'gap-billed', segmentId: billedSeg.id, taskId: 't-home', deviceId: billedSeg.deviceId, start: billedSeg.start, end: billedSeg.start.replace(/T(\d\d):(\d\d)/, (_m, h: string, m: string) => `T${h}:${String(Number(m) + 5).padStart(2, '0')}`), kind: 'idle', decision: 'keep', decisionStamp: { at: '', by: '' } });
    boot(s);
    const dialog = await openDetails(user, 'Homepage layout', 'Time away');
    const row = within(dialog).getAllByRole('listitem').find((li) => li.getAttribute('data-gap-id') === 'gap-billed');
    expect(row).toBeDefined();
    expect(row).toHaveTextContent('This time is on a billing summary; void that summary first.');
    expect(within(row as HTMLElement).queryByRole('button', { name: 'Drop' })).toBeNull();
  });
});

function snap_(s: MockState): Snapshot {
  return handle(s, 'get_snapshot', {}) as Snapshot;
}
