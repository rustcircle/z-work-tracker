// Deleting a task from its Details, through the real app on the IPC mock: where the button is, the two dialogs, backing
// out of each, the mouse-only rule, the second click of a double click, what stops a delete and what the backend refuses
// that the page could not see, and what goes with the task (the Timeline, the selection, the editor and what it held).
import { emit } from '@tauri-apps/api/event';
import { clearMocks } from '@tauri-apps/api/mocks';
import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { boot as bootApp, polyfillDom } from '../../../components/testKit';
import { api } from '../../../lib/api';
import type { WithId } from '../../../lib/types';
import { demoState } from '../../../mocks/demoSeed';
import { DEVICE_ID, captureData, emptyState, handle, type MockState } from '../../../mocks/ipcMock';
import { ARM_MS } from './DeleteTask';

type User = ReturnType<typeof userEvent.setup>;

let state: MockState;
const boot = (s: MockState) => {
  state = s;
  return bootApp(s);
};
const call = <T,>(s: MockState, cmd: string, a: Record<string, unknown> = {}) => handle(s, cmd, a) as T;
const calls = (cmd: string) => state.calls.filter((c) => c.cmd === cmd);
const pass = (ms: number) => act(() => vi.advanceTimersByTimeAsync(ms));
const mouse = (): User => userEvent.setup({ advanceTimers: vi.advanceTimersByTime.bind(vi) });

const REVIEW = 'Delete this task?';
const FINAL = (name: string) => `Delete “${name}” for good?`;
const ALL_RETRIES_MS = 70_000;

beforeEach(() => {
  polyfillDom();
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'], shouldAdvanceTime: true });
});
afterEach(async () => {
  cleanup();
  // An editor saves what is pending as it unmounts, and a failing one retries: the mock has to outlast that.
  await act(() => vi.advanceTimersByTimeAsync(ALL_RETRIES_MS));
  clearMocks();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

/**
 * Two stopped tasks in a billable project at EUR 60 an hour with rounding off, so every figure is plain to work out.
 * Quarterly report has an hour on Tuesday 10 March and an hour on Wednesday 11 March (2h 00m on 2 days, EUR 120.00).
 * Inbox zero has an hour on the 11th (EUR 60.00). The week of the 12th then holds 3h 00m and EUR 180.00.
 */
function world() {
  const s = emptyState('2026-03-12T15:20:00Z');
  const project = call<WithId>(s, 'create_project', { input: { name: 'Site', color: '#2563EB', billable: true, budgetHours: null, clientZone: null } }).id;
  call(s, 'set_rate', { input: { projectId: project, rateCents: 6000, currency: 'EUR', effectiveFrom: '2026-01-01T00:00:00Z', confirmRetroactive: true } });
  call(s, 'set_rounding', { input: { projectId: null, effectiveFrom: '2000-01-01', incrementMinutes: 0, method: 'up', confirmRetroactive: true }, today: '2026-03-12' });
  const stopped = (name: string, spans: [string, string][]): string => {
    const id = call<WithId>(s, 'create_task', { input: { name, projectId: project, description: null } }).id;
    const t = s.tasks.find((x) => x.id === id);
    if (!t) throw new Error('no task');
    t.state = 'stopped';
    t.stoppedAt = '2026-03-11T15:00:00Z';
    spans.forEach(([start, end], i) => s.segments.push({ id: `${id}-s${i}`, taskId: id, deviceId: DEVICE_ID, start, end, provisionalEnd: null }));
    return id;
  };
  const report = stopped('Quarterly report', [
    ['2026-03-10T09:00:00Z', '2026-03-10T10:00:00Z'],
    ['2026-03-11T09:00:00Z', '2026-03-11T10:00:00Z'],
  ]);
  const other = stopped('Inbox zero', [['2026-03-11T13:00:00Z', '2026-03-11T14:00:00Z']]);
  return { s, project, report, other };
}

const entriesOf = (name: string): HTMLElement[] => screen.queryAllByTestId('entry').filter((row) => within(row).queryByRole('button', { name }) !== null);

async function openDetails(u: User, name: string): Promise<HTMLElement> {
  const article = await screen.findByRole('article', { name });
  await u.click(within(article).getByRole('button', { name: 'Details' }));
  return screen.findByRole('dialog', { name: `Details: ${name}` });
}
const trigger = (details: HTMLElement): HTMLElement => within(details).getByRole('button', { name: 'Delete task' });
const review = (): Promise<HTMLElement> => screen.findByRole('dialog', { name: REVIEW });
const final = (name: string): Promise<HTMLElement> => screen.findByRole('dialog', { name: FINAL(name) });
const button = (dialog: HTMLElement, name: string): HTMLElement => within(dialog).getByRole('button', { name });
/** Tab would do it in a browser. jsdom has no layout, so the dialog's own Tab trap sees one button, and focus is put there directly. */
const focus = (el: HTMLElement): void => act(() => el.focus());

/** Through the review and on to the last dialog, with a mouse, and the second that keeps a press from counting passed. */
async function toFinal(u: User, name: string): Promise<{ details: HTMLElement; last: HTMLElement }> {
  const details = await openDetails(u, name);
  await u.click(trigger(details));
  const first = await review();
  await pass(ARM_MS);
  await u.click(button(first, 'Continue'));
  const last = await final(name);
  await pass(ARM_MS);
  return { details, last };
}

/** The p2 seed has pending time away, so the time-away dialog opens on load; these tests are about something else. */
async function dismissAway(u: User): Promise<void> {
  try {
    await screen.findByRole('dialog', { name: /You were away/ }, { timeout: 600 });
  } catch {
    return;
  }
  // A dialog that opened by itself has not set up its keys yet.
  await pass(100);
  await u.keyboard('{Escape}');
  await waitFor(() => expect(screen.queryByRole('dialog', { name: /You were away/ })).toBeNull());
}

describe('where the button is', () => {
  it('is in the Details of a started task, in red and under the tabs, and not on a card, a draft or a Timeline row', async () => {
    const { s } = world();
    call(s, 'create_task', { input: { name: 'Fresh idea', projectId: s.projects[0]?.id, description: null } });
    const u = mouse();
    boot(s);
    const card = await screen.findByRole('article', { name: 'Quarterly report' });
    expect(within(card).queryByRole('button', { name: /delete/i })).toBeNull();
    const rows = await screen.findAllByTestId('entry');
    expect(rows.length).toBe(3);
    for (const row of rows) expect(within(row).queryByRole('button', { name: /delete/i })).toBeNull();
    // A draft keeps its own button and its one dialog, and has no Details to hold this one.
    const draft = screen.getByRole('article', { name: 'Fresh idea' });
    expect(within(draft).queryByRole('button', { name: 'Details' })).toBeNull();
    expect(within(draft).getByRole('button', { name: 'Delete draft Fresh idea' })).toBeInTheDocument();

    const details = await openDetails(u, 'Quarterly report');
    const del = trigger(details);
    expect(del).toHaveClass('btn-danger');
    expect(del).toBeEnabled();
    const panel = within(details).getByRole('tabpanel');
    expect(panel).not.toContainElement(del);
    expect(panel.compareDocumentPosition(del) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(within(details).getByRole('heading', { name: 'Delete this task' })).toBeInTheDocument();
    expect(calls('delete_task')).toHaveLength(0);
  });
});

describe('the review', () => {
  it('names the task and what goes with it, says it is the whole task, and asks nothing of the backend yet', async () => {
    const { s } = world();
    const u = mouse();
    boot(s);
    const details = await openDetails(u, 'Quarterly report');
    await u.click(trigger(details));
    const dialog = await review();
    expect(dialog).toHaveTextContent('“Quarterly report” in Site will be deleted from Mock PC and from synced devices, with everything logged on it.');
    const figures = within(dialog).getByLabelText('What goes with it');
    expect(within(figures).getByText('2h 00m on 2 days')).toBeInTheDocument();
    expect(within(figures).getByText('€120.00')).toBeInTheDocument();
    expect(within(figures).queryByText('Unconfirmed')).toBeNull();
    expect(dialog).toHaveTextContent("This removes the whole task and all its time, not only one day's entry.");
    expect(dialog).toHaveTextContent('It goes from the Timeline, Analysis, billing, budgets and exports.');
    expect(dialog).toHaveTextContent("This can't be undone in the app. The only way back is to restore a backup made before the delete (Settings, Backups)");
    expect(button(dialog, 'Keep it')).toHaveFocus();
    expect(button(dialog, 'Continue')).toBeInTheDocument();
    expect(calls('delete_task')).toHaveLength(0);
  });

  it('with sync on says it cannot be undone, reaches the other PCs, and that a restored backup only holds until the next sync', async () => {
    const { s } = world();
    s.targets.push({ provider: 'oneDrive', root: 'C:\\OneDrive', folder: 'C:\\OneDrive\\zWorkTracker', status: { lastWrittenAt: null, lastReadAt: null, lastError: null, lastErrorAt: null, warnings: [], ignoredFiles: 0, devicesSeen: 0 } });
    const u = mouse();
    boot(s);
    await u.click(trigger(await openDetails(u, 'Quarterly report')));
    const dialog = await review();
    expect(dialog).toHaveTextContent("With sync on, this can't be undone. It reaches your other devices at their next sync.");
    expect(dialog).toHaveTextContent('Restoring a backup made before the delete (Settings, Backups) brings the task back only until the next sync merges the delete in again.');
  });

  it('masks the earnings while Hide earnings is on, and shows them otherwise', async () => {
    const { s } = world();
    s.hideEarnings = true;
    const u = mouse();
    boot(s);
    await u.click(trigger(await openDetails(u, 'Quarterly report')));
    const dialog = await review();
    const figures = within(dialog).getByLabelText('What goes with it');
    expect(within(figures).getByText('••••')).toBeInTheDocument();
    expect(figures).toHaveTextContent('Earnings••••');
    // The time is not money, and stays.
    expect(within(figures).getByText('2h 00m on 2 days')).toBeInTheDocument();
    expect(dialog.textContent).not.toMatch(/[€$]\s?\d/);
    // Nothing of the amount hides in a name or a tooltip either.
    const labels = [...dialog.querySelectorAll('*')].flatMap((el) => [el.getAttribute('title'), el.getAttribute('aria-label')]).join(' ');
    expect(labels).not.toMatch(/120|€/);
  });

  it('shows no earnings line for a task that earns nothing', async () => {
    const { s, project } = world();
    s.rates = [];
    expect(s.projects.find((p) => p.id === project)).toBeDefined();
    const u = mouse();
    boot(s);
    await u.click(trigger(await openDetails(u, 'Quarterly report')));
    const figures = within(await review()).getByLabelText('What goes with it');
    expect(within(figures).queryByText('Earnings')).toBeNull();
    expect(within(figures).getByText('2h 00m on 2 days')).toBeInTheDocument();
  });

  it('lists time away still waiting for an answer, and the tasks that continue this one, which stay unlinked', async () => {
    const { s, report } = world();
    s.gaps.push({ id: 'gap-1', segmentId: `${report}-s0`, taskId: report, deviceId: DEVICE_ID, start: '2026-03-10T09:10:00Z', end: '2026-03-10T09:40:00Z', kind: 'idle', decision: 'pending', decisionStamp: { at: '2026-03-10T09:40:00Z', by: DEVICE_ID } });
    call(s, 'create_task', { input: { name: 'Quarterly report, part 2', projectId: s.projects[0]?.id, description: null, continuedFrom: report } });
    const u = mouse();
    boot(s);
    await dismissAway(u);
    // The card of the follow-up says what it continues.
    expect(within(await screen.findByRole('article', { name: 'Quarterly report, part 2' })).getByText('Quarterly report', { selector: 'button' })).toBeInTheDocument();
    await u.click(trigger(await openDetails(u, 'Quarterly report')));
    const dialog = await review();
    const figures = within(dialog).getByLabelText('What goes with it');
    expect(within(figures).getByText('30m of time away, not counted')).toBeInTheDocument();
    expect(within(figures).getByText('Unconfirmed')).toBeInTheDocument();
    expect(dialog).toHaveTextContent('“Quarterly report, part 2” continues it and stays, without the link.');
    // Several are named, as many as fit.
    for (const n of [3, 4, 5]) call(s, 'create_task', { input: { name: `Part ${n}`, projectId: s.projects[0]?.id, description: null, continuedFrom: report } });
    await u.keyboard('{Escape}');
    await act(() => emit('state-changed'));
    await u.click(trigger(screen.getByRole('dialog', { name: 'Details: Quarterly report' })));
    expect(await review()).toHaveTextContent('4 tasks continue it: “Quarterly report, part 2”, “Part 3”, “Part 4” and 1 more. They stay, without the link.');
  });
});

describe('backing out', () => {
  it('Keep it in the review changes nothing, closes only the review, and gives focus back to the button', async () => {
    const { s } = world();
    const u = mouse();
    boot(s);
    const details = await openDetails(u, 'Quarterly report');
    await u.click(trigger(details));
    await u.click(button(await review(), 'Keep it'));
    expect(screen.queryByRole('dialog', { name: REVIEW })).toBeNull();
    expect(details).toBeInTheDocument();
    expect(trigger(details)).toHaveFocus();
    expect(calls('delete_task')).toHaveLength(0);
    expect(s.tasks.map((t) => t.name)).toContain('Quarterly report');
  });

  it('Esc in the review does the same, and leaves the Details open', async () => {
    const { s } = world();
    const u = mouse();
    boot(s);
    const details = await openDetails(u, 'Quarterly report');
    await u.click(trigger(details));
    await review();
    await u.keyboard('{Escape}');
    expect(screen.queryByRole('dialog', { name: REVIEW })).toBeNull();
    expect(screen.getByRole('dialog', { name: 'Details: Quarterly report' })).toBeInTheDocument();
    expect(trigger(details)).toHaveFocus();
    expect(calls('delete_task')).toHaveLength(0);
  });

  it('Keep it in the last dialog changes nothing, and the next try starts again at the review', async () => {
    const { s } = world();
    const u = mouse();
    boot(s);
    const { details, last } = await toFinal(u, 'Quarterly report');
    await u.click(button(last, 'Keep it'));
    expect(screen.queryByRole('dialog', { name: FINAL('Quarterly report') })).toBeNull();
    expect(screen.queryByRole('dialog', { name: REVIEW })).toBeNull();
    expect(details).toBeInTheDocument();
    expect(trigger(details)).toHaveFocus();
    expect(calls('delete_task')).toHaveLength(0);
    await u.click(trigger(details));
    expect(await review()).toBeInTheDocument();
    expect(screen.queryByRole('dialog', { name: FINAL('Quarterly report') })).toBeNull();
  });

  it('Esc in the last dialog closes it and only it, and the next try starts again at the review', async () => {
    const { s } = world();
    const u = mouse();
    boot(s);
    const { details } = await toFinal(u, 'Quarterly report');
    await u.keyboard('{Escape}');
    expect(screen.queryByRole('dialog', { name: FINAL('Quarterly report') })).toBeNull();
    expect(screen.getByRole('dialog', { name: 'Details: Quarterly report' })).toBeInTheDocument();
    expect(calls('delete_task')).toHaveLength(0);
    await u.click(trigger(details));
    expect(await review()).toBeInTheDocument();
  });

  it('a click beside a dialog does nothing, and neither dialog has a close button, so a stray click decides nothing', async () => {
    const { s } = world();
    const u = mouse();
    boot(s);
    await u.click(trigger(await openDetails(u, 'Quarterly report')));
    const first = await review();
    expect(within(first).queryByRole('button', { name: 'Close dialog' })).toBeNull();
    fireEvent.mouseDown(first.parentElement as HTMLElement);
    expect(first).toBeInTheDocument();
    await pass(ARM_MS);
    await u.click(button(first, 'Continue'));
    const last = await final('Quarterly report');
    expect(within(last).queryByRole('button', { name: 'Close dialog' })).toBeNull();
    fireEvent.mouseDown(last.parentElement as HTMLElement);
    expect(last).toBeInTheDocument();
    expect(calls('delete_task')).toHaveLength(0);
  });
});

describe('the last dialog', () => {
  it('asks for the task by name, with Keep it in focus, and only Delete task goes on', async () => {
    const { s } = world();
    const u = mouse();
    boot(s);
    const { last } = await toFinal(u, 'Quarterly report');
    expect(last).toHaveTextContent('This deletes “Quarterly report” and the 2h 00m logged on it from Mock PC and from synced devices. It can\'t be undone.');
    expect(button(last, 'Keep it')).toHaveFocus();
    expect(button(last, 'Delete task')).toHaveClass('btn-danger');
    expect(calls('delete_task')).toHaveLength(0);
  });
});

describe('only a mouse click goes on', () => {
  it('Enter does nothing in the review, on any button, and a click on Continue does', async () => {
    const { s } = world();
    const u = mouse();
    boot(s);
    await u.click(trigger(await openDetails(u, 'Quarterly report')));
    const first = await review();
    await pass(ARM_MS);
    const keep = button(first, 'Keep it');
    expect(keep).toHaveFocus();
    await u.keyboard('{Enter}');
    expect(first).toBeInTheDocument();
    // On Continue, Enter and Space press it, and neither goes on.
    const cont = button(first, 'Continue');
    focus(cont);
    await u.keyboard('{Enter}');
    await u.keyboard(' ');
    expect(first).toBeInTheDocument();
    expect(screen.queryByRole('dialog', { name: FINAL('Quarterly report') })).toBeNull();
    // A mouse click does.
    await u.click(cont);
    expect(await final('Quarterly report')).toBeInTheDocument();
    expect(screen.queryByRole('dialog', { name: REVIEW })).toBeNull();
  });

  it('Enter and Space on Delete task delete nothing, Enter on Keep it does nothing, and a mouse click deletes', async () => {
    const { s, report } = world();
    const u = mouse();
    boot(s);
    const { last } = await toFinal(u, 'Quarterly report');
    const keep = button(last, 'Keep it');
    expect(keep).toHaveFocus();
    await u.keyboard('{Enter}');
    expect(last).toBeInTheDocument();
    const del = button(last, 'Delete task');
    focus(del);
    await u.keyboard('{Enter}');
    await u.keyboard(' ');
    await pass(100);
    expect(last).toBeInTheDocument();
    expect(calls('delete_task')).toHaveLength(0);
    expect(s.tasks.map((t) => t.id)).toContain(report);
    await u.click(del);
    await waitFor(() => expect(calls('delete_task')).toHaveLength(1));
    expect(s.tasks.map((t) => t.id)).not.toContain(report);
  });

  it('holding Enter down as the Details button opens the review presses nothing in it', async () => {
    const { s } = world();
    const u = mouse();
    boot(s);
    const details = await openDetails(u, 'Quarterly report');
    trigger(details).focus();
    // The key that opens the review goes on repeating into it.
    await u.keyboard('{Enter>3/}');
    const dialog = await review();
    await pass(ARM_MS);
    expect(dialog).toBeInTheDocument();
    expect(calls('delete_task')).toHaveLength(0);
  });

  it('Space on Keep it backs out, as a key may', async () => {
    const { s } = world();
    const u = mouse();
    boot(s);
    const details = await openDetails(u, 'Quarterly report');
    await u.click(trigger(details));
    const first = await review();
    expect(button(first, 'Keep it')).toHaveFocus();
    await u.keyboard(' ');
    expect(screen.queryByRole('dialog', { name: REVIEW })).toBeNull();
    expect(calls('delete_task')).toHaveLength(0);
  });

  it('Enter does nothing anywhere while a dialog is up, even on the Details button behind it, and Esc still backs out', async () => {
    const { s } = world();
    const u = mouse();
    boot(s);
    const details = await openDetails(u, 'Quarterly report');
    await u.click(trigger(details));
    const first = await review();
    // Focus is on the page behind, as when a click landed there: Enter would close the Details.
    focus(within(details).getByRole('button', { name: 'Close' }));
    await u.keyboard('{Enter}');
    expect(details).toBeInTheDocument();
    expect(first).toBeInTheDocument();
    await u.keyboard('{Escape}');
    expect(screen.queryByRole('dialog', { name: REVIEW })).toBeNull();
    expect(details).toBeInTheDocument();
  });
});

describe('the second click of a double click', () => {
  it('Continue and Delete task wait a second before they answer, and show it', async () => {
    const { s } = world();
    const u = mouse();
    boot(s);
    await u.click(trigger(await openDetails(u, 'Quarterly report')));
    const first = await review();
    expect(button(first, 'Continue')).toBeDisabled();
    await u.click(button(first, 'Continue'));
    expect(screen.queryByRole('dialog', { name: FINAL('Quarterly report') })).toBeNull();
    await pass(ARM_MS / 2);
    expect(button(first, 'Continue')).toBeDisabled();
    await pass(ARM_MS / 2);
    expect(button(first, 'Continue')).toBeEnabled();
    await u.click(button(first, 'Continue'));
    const last = await final('Quarterly report');
    expect(button(last, 'Delete task')).toBeDisabled();
    await u.click(button(last, 'Delete task'));
    await pass(ARM_MS / 2);
    expect(button(last, 'Delete task')).toBeDisabled();
    await pass(ARM_MS / 2);
    expect(button(last, 'Delete task')).toBeEnabled();
    expect(calls('delete_task')).toHaveLength(0);
  });

  it('a double click on Continue does not reach Delete task, even with the second click landing on it', async () => {
    const { s } = world();
    const u = mouse();
    boot(s);
    await u.click(trigger(await openDetails(u, 'Quarterly report')));
    const first = await review();
    await pass(ARM_MS);
    fireEvent.click(button(first, 'Continue'), { detail: 1 });
    const last = await final('Quarterly report');
    // The next dialog's button sits where Continue was, and is not ready for a click that quick.
    fireEvent.click(button(last, 'Delete task'), { detail: 2 });
    await pass(100);
    expect(calls('delete_task')).toHaveLength(0);
    expect(last).toBeInTheDocument();
  });

  it('a click counted as the second of a run does nothing, even after the second, and a lone click does', async () => {
    const { s, report } = world();
    const u = mouse();
    boot(s);
    const { last } = await toFinal(u, 'Quarterly report');
    const del = button(last, 'Delete task');
    expect(del).toBeEnabled();
    // The second and the third of a run, as a long double-click time allows them, and a click of no count (a key, a screen reader).
    fireEvent.click(del, { detail: 2 });
    fireEvent.click(del, { detail: 3 });
    fireEvent.click(del, { detail: 0 });
    await pass(100);
    expect(calls('delete_task')).toHaveLength(0);
    expect(s.tasks.map((t) => t.id)).toContain(report);
    await u.click(del);
    await waitFor(() => expect(calls('delete_task')).toHaveLength(1));
  });

  it('the same count guards Continue, so a double click on the button that opened the review cannot skip it', async () => {
    const { s } = world();
    const u = mouse();
    boot(s);
    await u.click(trigger(await openDetails(u, 'Quarterly report')));
    const first = await review();
    await pass(ARM_MS);
    fireEvent.click(button(first, 'Continue'), { detail: 2 });
    fireEvent.click(button(first, 'Continue'), { detail: 0 });
    await pass(100);
    expect(screen.queryByRole('dialog', { name: FINAL('Quarterly report') })).toBeNull();
    await u.click(button(first, 'Continue'));
    expect(await final('Quarterly report')).toBeInTheDocument();
  });
});

describe('deleting', () => {
  it('takes the task, its Timeline entries and its time away, closes every dialog, and says so', async () => {
    const { s, report, other } = world();
    const u = mouse();
    boot(s);
    expect(await screen.findByTestId('summary-this')).toHaveTextContent('3h 00m logged, rounding off (€180.00)');
    expect(entriesOf('Quarterly report')).toHaveLength(2);
    expect(entriesOf('Inbox zero')).toHaveLength(1);
    const { last } = await toFinal(u, 'Quarterly report');
    await u.click(button(last, 'Delete task'));
    await waitFor(() => expect(screen.queryByRole('article', { name: 'Quarterly report' })).toBeNull());
    expect(calls('delete_task').map((c) => c.args)).toEqual([{ id: report }]);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(entriesOf('Quarterly report')).toHaveLength(0);
    expect(entriesOf('Inbox zero')).toHaveLength(1);
    expect(screen.getByTestId('summary-this')).toHaveTextContent('1h 00m logged, rounding off (€60.00)');
    expect(screen.getByRole('article', { name: 'Inbox zero' })).toBeInTheDocument();
    expect(screen.getByText('Deleted “Quarterly report” and everything logged on it.')).toBeInTheDocument();
    expect(s.tasks.map((t) => t.id)).toEqual([other]);
    expect(s.segments.every((x) => x.taskId === other)).toBe(true);
  });

  it('is written in the audit trail of Settings in plain words', async () => {
    const { s } = world();
    const u = mouse();
    boot(s);
    const { last } = await toFinal(u, 'Quarterly report');
    await u.click(button(last, 'Delete task'));
    await waitFor(() => expect(screen.queryByRole('article', { name: 'Quarterly report' })).toBeNull());
    await u.click(screen.getByRole('tab', { name: 'Settings' }));
    await u.click(await screen.findByRole('button', { name: 'Load' }));
    const entry = (await screen.findAllByTestId('audit-entry')).find((e) => e.dataset.entity === 'task');
    expect(entry).toBeDefined();
    expect(entry).toHaveTextContent('Task deleted, with all its time by this computer (Mock PC)');
    expect(entry).toHaveTextContent('Before: “Quarterly report” in Site, stopped, 2 time entries. After: nothing.');
  });

  it('a refusal the page could not see goes to the usual banner and beside the button, and nothing closes but the dialog', async () => {
    const { s, report } = world();
    const u = mouse();
    boot(s);
    const { details, last } = await toFinal(u, 'Quarterly report');
    // A timer opens on this computer, say from the tray, and the page has not heard.
    s.segments.push({ id: 'here-now', taskId: report, deviceId: DEVICE_ID, start: '2026-03-12T14:00:00Z', end: null, provisionalEnd: null });
    await u.click(button(last, 'Delete task'));
    const message = 'this task is running; pause or stop it before deleting it';
    await waitFor(() => expect(document.querySelector('.banner-error')).toHaveTextContent(message));
    expect(within(details).getByRole('alert')).toHaveTextContent('This task is running; pause or stop it before deleting it.');
    expect(screen.queryByRole('dialog', { name: FINAL('Quarterly report') })).toBeNull();
    expect(details).toBeInTheDocument();
    expect(screen.getByRole('article', { name: 'Quarterly report' })).toBeInTheDocument();
    expect(screen.queryByText(/^Deleted “/)).toBeNull();
    expect(calls('delete_task')).toHaveLength(1);
    expect(s.tasks.map((t) => t.id)).toContain(report);
    // Once the page has heard, the reason stands beside a button that cannot be pressed.
    await act(() => emit('state-changed'));
    await waitFor(() => expect(trigger(details)).toBeDisabled());
    expect(within(details).getByText('This task is running. Pause or stop it first, then delete it.')).toBeInTheDocument();
  });

  it('a failing call is reported the same way, and the next try starts at the review', async () => {
    const { s } = world();
    const u = mouse();
    boot(s);
    const { details, last } = await toFinal(u, 'Quarterly report');
    s.failNext = ['delete_task'];
    await u.click(button(last, 'Delete task'));
    await waitFor(() => expect(document.querySelector('.banner-error')).toHaveTextContent('mock: delete_task failed'));
    expect(within(details).getByRole('alert')).toHaveTextContent('Mock: delete_task failed.');
    expect(screen.queryByRole('dialog', { name: FINAL('Quarterly report') })).toBeNull();
    await u.click(trigger(details));
    expect(await review()).toBeInTheDocument();
  });

  it('only sends the delete once, however many times Delete task is clicked', async () => {
    const { s } = world();
    const u = mouse();
    boot(s);
    const { last } = await toFinal(u, 'Quarterly report');
    const del = button(last, 'Delete task');
    await u.click(del);
    await u.click(del);
    await waitFor(() => expect(screen.queryByRole('article', { name: 'Quarterly report' })).toBeNull());
    expect(calls('delete_task')).toHaveLength(1);
  });

  it('the follow-up of a deleted task stays, with no link to it', async () => {
    const { s, report } = world();
    call(s, 'create_task', { input: { name: 'Quarterly report, part 2', projectId: s.projects[0]?.id, description: null, continuedFrom: report } });
    const u = mouse();
    boot(s);
    const follow = await screen.findByRole('article', { name: 'Quarterly report, part 2' });
    expect(within(follow).getByText(/Continued from/)).toBeInTheDocument();
    const { last } = await toFinal(u, 'Quarterly report');
    await u.click(button(last, 'Delete task'));
    await waitFor(() => expect(screen.queryByRole('article', { name: 'Quarterly report' })).toBeNull());
    const after = screen.getByRole('article', { name: 'Quarterly report, part 2' });
    expect(within(after).queryByText(/Continued from/)).toBeNull();
    expect(within(after).queryByText('an earlier task')).toBeNull();
  });
});

describe('what stops a delete, said beside the button', () => {
  it('a task running here: the button cannot be pressed, the reason is on the page, and pausing it frees the button', async () => {
    const s = demoState();
    const u = mouse();
    boot(s);
    const details = await openDetails(u, 'Logo concepts');
    const del = trigger(details);
    expect(del).toBeDisabled();
    const why = within(details).getByText('This task is running. Pause or stop it first, then delete it.');
    expect(why).toBeVisible();
    expect(del).toHaveAccessibleDescription('This task is running. Pause or stop it first, then delete it.');
    await u.click(del);
    expect(screen.queryByRole('dialog', { name: REVIEW })).toBeNull();
    expect(calls('delete_task')).toHaveLength(0);
    // Paused from elsewhere in the app, the reason goes and the button is ready.
    call(s, 'pause_task', { id: 't-logo' });
    await act(() => emit('state-changed'));
    await waitFor(() => expect(trigger(details)).toBeEnabled());
    expect(within(details).queryByTestId('delete-blocked')).toBeNull();
  });

  it('time on a live billing summary: the summary is named, Open Billing goes to the tab, and voiding it frees the button', async () => {
    const { s } = world();
    call(s, 'create_summary', { request: { projectId: s.projects[0]?.id, from: '2026-03-09', to: '2026-03-15', zone: 'Europe/Lisbon' } });
    const u = mouse();
    boot(s);
    const details = await openDetails(u, 'Quarterly report');
    expect(trigger(details)).toBeDisabled();
    expect(within(details).getByTestId('delete-blocked')).toHaveTextContent("This task's time is on billing summary A-001. Void that summary first, then delete the task.");
    await u.click(within(details).getByRole('button', { name: 'Open Billing' }));
    expect(screen.queryByRole('dialog', { name: 'Details: Quarterly report' })).toBeNull();
    expect(screen.getByRole('tab', { name: 'Billing', selected: true })).toBeInTheDocument();
    // Voided there, the task can go.
    const summary = s.summaries[0];
    if (!summary) throw new Error('no summary');
    call(s, 'void_summary', { id: summary.id });
    await act(() => emit('state-changed'));
    const again = await openDetails(u, 'Quarterly report');
    expect(trigger(again)).toBeEnabled();
    expect(within(again).queryByTestId('delete-blocked')).toBeNull();
  });

  it('several live summaries are all named', async () => {
    const { s, report } = world();
    const project = s.projects[0]?.id;
    call(s, 'create_summary', { request: { projectId: project, from: '2026-03-09', to: '2026-03-15', zone: 'Europe/Lisbon' } });
    call(s, 'add_manual_entry', { input: { taskId: report, start: '2026-03-12T10:00:00Z', end: '2026-03-12T11:00:00Z', reason: 'More', allowOverlap: true } });
    call(s, 'create_summary', { request: { projectId: project, from: '2026-03-09', to: '2026-03-15', zone: 'Europe/Lisbon' } });
    const u = mouse();
    boot(s);
    const details = await openDetails(u, 'Quarterly report');
    expect(within(details).getByTestId('delete-blocked')).toHaveTextContent("This task's time is on billing summaries A-001 and A-002. Void those summaries first, then delete the task.");
  });

  it('running and on a summary: both reasons are given, the first one first', async () => {
    const s = demoState();
    call(s, 'stop_task', { id: 't-logo' });
    call(s, 'create_summary', { request: { projectId: 'p-brand', from: '2026-02-23', to: '2026-03-06', zone: 'Europe/Lisbon' } });
    s.segments.push({ id: 'open-again', taskId: 't-logo', deviceId: DEVICE_ID, start: '2026-03-12T15:00:00Z', end: null, provisionalEnd: null });
    const u = mouse();
    boot(s);
    const details = await openDetails(u, 'Logo concepts');
    const reasons = within(details).getAllByTestId('delete-blocked').map((p) => p.textContent);
    expect(reasons[0]).toContain('This task is running.');
    expect(reasons[1]).toContain('billing summary A-001');
    expect(trigger(details)).toBeDisabled();
  });

  it('a voided summary stops nothing, the voided summary keeps the task’s name and says its time is gone', async () => {
    const { s } = world();
    call(s, 'create_summary', { request: { projectId: s.projects[0]?.id, from: '2026-03-09', to: '2026-03-15', zone: 'Europe/Lisbon' } });
    const summary = s.summaries[0];
    if (!summary) throw new Error('no summary');
    call(s, 'void_summary', { id: summary.id });
    const u = mouse();
    boot(s);
    const { details, last } = await toFinal(u, 'Quarterly report');
    expect(within(details).queryByTestId('delete-blocked')).toBeNull();
    await u.click(button(last, 'Delete task'));
    await waitFor(() => expect(screen.queryByRole('article', { name: 'Quarterly report' })).toBeNull());
    await u.click(screen.getByRole('tab', { name: 'Billing' }));
    const card = await screen.findByRole('listitem', { name: 'A-001, voided' });
    // The rows still name the task, as issued, and the card says that time is not coming back as unbilled.
    expect(within(card).getAllByText('Quarterly report', { selector: 'td' })).toHaveLength(2);
    expect(within(card).getByTestId('summary-deleted')).toHaveTextContent('“Quarterly report” was deleted after this summary was voided, so its time is gone and is not unbilled again.');
    // Inbox zero is still there, so its row is not called deleted.
    expect(within(card).getByTestId('summary-deleted')).not.toHaveTextContent('Inbox zero');
  });
});

describe('what goes with the task', () => {
  async function select(u: User, rows: HTMLElement[]): Promise<void> {
    await u.click(rows[0] as HTMLElement);
    for (const row of rows.slice(1)) {
      await u.keyboard('{Control>}');
      await u.click(row);
      await u.keyboard('{/Control}');
    }
  }

  it('its entries leave the selection, wherever the Timeline is, and the bar, its total and the Export button are right', async () => {
    const { s } = world();
    const u = mouse();
    boot(s);
    await screen.findAllByTestId('entry');
    await select(u, [...entriesOf('Quarterly report'), ...entriesOf('Inbox zero')]);
    const bar = screen.getByTestId('selection-bar');
    expect(within(bar).getByTestId('selection-count')).toHaveTextContent('3 tasks selected');
    expect(screen.getByRole('button', { name: 'Export (3 selected)' })).toBeInTheDocument();
    // The Timeline is not on screen when the task goes.
    await u.click(screen.getByRole('tab', { name: 'Analysis' }));
    const { last } = await toFinal(u, 'Quarterly report');
    await u.click(button(last, 'Delete task'));
    await waitFor(() => expect(screen.queryByRole('article', { name: 'Quarterly report' })).toBeNull());
    expect(screen.getByRole('button', { name: 'Export (1 selected)' })).toBeInTheDocument();
    await u.click(screen.getByRole('tab', { name: 'Timeline' }));
    const after = await screen.findByTestId('selection-bar');
    expect(within(after).getByTestId('selection-count')).toHaveTextContent('1 task selected');
    expect(within(after).getByTestId('selection-total')).toHaveTextContent('Total Billable 1h 00m · €60.00');
    expect(screen.getAllByTestId('entry').filter((r) => r.getAttribute('aria-selected') === 'true').map((r) => within(r).getAllByRole('button')[0]?.textContent)).toEqual(['Inbox zero']);
    // What is sent for export is the survivor alone, and the backend takes it.
    await u.click(within(after).getByRole('button', { name: 'Export selected' }));
    const dialog = await screen.findByRole('dialog', { name: /Export/ });
    expect(dialog).toBeInTheDocument();
  });

  it('a selection of nothing but its entries is gone, with the bar', async () => {
    const { s } = world();
    const u = mouse();
    boot(s);
    await screen.findAllByTestId('entry');
    await select(u, entriesOf('Quarterly report'));
    expect(screen.getByTestId('selection-count')).toHaveTextContent('2 tasks selected');
    const { last } = await toFinal(u, 'Quarterly report');
    await u.click(button(last, 'Delete task'));
    await waitFor(() => expect(screen.queryByRole('article', { name: 'Quarterly report' })).toBeNull());
    expect(screen.queryByTestId('selection-bar')).toBeNull();
    expect(screen.getByRole('button', { name: 'Export' })).toBeInTheDocument();
    expect(screen.getByTestId('selection-live')).toHaveTextContent('Selection cleared');
  });

  it('a selection that never held the task is left alone', async () => {
    const { s } = world();
    const u = mouse();
    boot(s);
    await screen.findAllByTestId('entry');
    await select(u, entriesOf('Inbox zero'));
    const { last } = await toFinal(u, 'Quarterly report');
    await u.click(button(last, 'Delete task'));
    await waitFor(() => expect(screen.queryByRole('article', { name: 'Quarterly report' })).toBeNull());
    expect(screen.getByTestId('selection-count')).toHaveTextContent('1 task selected');
  });
});

describe('the editor of the task, and what it held', () => {
  const elsewhere = { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'From another device' }] }] };
  const noticesShown = () => screen.queryAllByTestId('notice').map((n) => n.textContent ?? '');
  const form = () => screen.getByRole('form', { name: /^Editing / });
  const box = () => within(form()).getByRole('textbox', { name: 'Description' });
  const kind = () => within(form()).getByTestId('save-state').getAttribute('data-kind');

  /** Words typed, newer text in, and the autosave has met it: the words are held, and the notice is up. */
  async function holdWords(u: User, s: MockState, id: string): Promise<void> {
    await u.click(await screen.findByRole('button', { name: 'Edit Quarterly report' }));
    await u.click(box());
    await u.keyboard(' mine');
    const t = s.tasks.find((x) => x.id === id);
    if (!t) throw new Error('no task');
    t.description = elsewhere;
    s.revision += 1;
    await act(() => emit('state-changed'));
    await pass(1500);
    expect(kind()).toBe('conflict');
  }

  it('held words go with it, without a word about a task deleted elsewhere, and nothing of them is kept for the next launch', async () => {
    const { s, report } = world();
    const u = mouse();
    boot(s);
    await holdWords(u, s, report);
    expect(JSON.stringify(s.drafts[report])).toContain('mine');
    const { last } = await toFinal(u, 'Quarterly report');
    await u.click(button(last, 'Delete task'));
    await waitFor(() => expect(screen.queryByRole('article', { name: 'Quarterly report' })).toBeNull());
    await pass(5000);
    expect(screen.queryByRole('form', { name: /^Editing / })).toBeNull();
    expect(noticesShown()).toEqual([]);
    expect(s.notices).toEqual([]);
    expect(calls('keep_unsaved_words')).toHaveLength(0);
    expect(screen.queryByTestId('unsent-banner')).toBeNull();
    expect(screen.queryByTestId('held-banner')).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(s.drafts[report]).toBeUndefined();
    expect(calls('clear_draft').map((c) => c.args)).toContainEqual({ taskId: report });
  });

  it('the same words, when the task is deleted somewhere else, do come back in a notice', async () => {
    const { s, report } = world();
    const u = mouse();
    boot(s);
    await holdWords(u, s, report);
    s.tasks = s.tasks.filter((t) => t.id !== report);
    s.revision += 1;
    await act(() => emit('state-changed'));
    await pass(5000);
    expect(noticesShown()).toHaveLength(1);
    expect(noticesShown()[0]).toContain('mine');
    expect(calls('keep_unsaved_words')).toHaveLength(1);
  });

  it('when a restored backup brings the task back, nothing of the old editor or of the words it held comes with it', async () => {
    const { s, report } = world();
    const backup = 'z-work-data-2026-03-11.json';
    s.backupData[backup] = captureData(s);
    s.backups.push({ name: backup, bytes: 1000, safety: false });
    const u = mouse();
    boot(s);
    await holdWords(u, s, report);
    // The editor is closed with the words still held: a banner says they wait.
    await u.click(screen.getByRole('button', { name: 'Edit Quarterly report' }));
    expect(await screen.findByTestId('held-banner')).toBeInTheDocument();
    const { last } = await toFinal(u, 'Quarterly report');
    await u.click(button(last, 'Delete task'));
    await waitFor(() => expect(screen.queryByRole('article', { name: 'Quarterly report' })).toBeNull());
    expect(screen.queryByTestId('held-banner')).toBeNull();
    // The backup from before the delete is restored, and the task is back.
    call(s, 'restore_backup', { name: backup });
    await act(() => emit('state-changed'));
    expect(await screen.findByRole('article', { name: 'Quarterly report' })).toBeInTheDocument();
    await pass(2000);
    expect(screen.queryByTestId('held-banner')).toBeNull();
    expect(screen.queryByRole('form', { name: /^Editing / })).toBeNull();
    expect(calls('keep_unsaved_words')).toHaveLength(0);
  });

  it('an editor open on the task does not open again when a restored backup brings the task back', async () => {
    const { s } = world();
    const backup = 'z-work-data-2026-03-11.json';
    s.backupData[backup] = captureData(s);
    s.backups.push({ name: backup, bytes: 1000, safety: false });
    const u = mouse();
    boot(s);
    await u.click(await screen.findByRole('button', { name: 'Edit Quarterly report' }));
    expect(form()).toBeInTheDocument();
    const { last } = await toFinal(u, 'Quarterly report');
    await u.click(button(last, 'Delete task'));
    await waitFor(() => expect(screen.queryByRole('article', { name: 'Quarterly report' })).toBeNull());
    call(s, 'restore_backup', { name: backup });
    await act(() => emit('state-changed'));
    const back = await screen.findByRole('article', { name: 'Quarterly report' });
    await pass(1000);
    expect(screen.queryByRole('form', { name: /^Editing / })).toBeNull();
    expect(within(back).getByRole('button', { name: 'Edit Quarterly report' })).toHaveAttribute('aria-expanded', 'false');
  });

  it('a banner about words whose save keeps failing does not come back with a restored task either', async () => {
    const { s, report } = world();
    const backup = 'z-work-data-2026-03-11.json';
    s.backupData[backup] = captureData(s);
    s.backups.push({ name: backup, bytes: 1000, safety: false });
    vi.spyOn(api, 'patchTask').mockRejectedValue({ code: 'io', message: 'the data file is locked' });
    const u = mouse();
    boot(s);
    await u.click(await screen.findByRole('button', { name: 'Edit Quarterly report' }));
    await u.click(box());
    await u.keyboard(' mine');
    await pass(1000);
    expect(kind()).toBe('failed');
    // Closed with the words still unsent: a banner says they wait.
    await u.click(screen.getByRole('button', { name: 'Edit Quarterly report' }));
    expect(await screen.findByTestId('unsent-banner')).toBeInTheDocument();
    const { last } = await toFinal(u, 'Quarterly report');
    await u.click(button(last, 'Delete task'));
    await waitFor(() => expect(screen.queryByRole('article', { name: 'Quarterly report' })).toBeNull());
    call(s, 'restore_backup', { name: backup });
    await act(() => emit('state-changed'));
    expect(await screen.findByRole('article', { name: 'Quarterly report' })).toBeInTheDocument();
    await pass(2000);
    expect(screen.queryByTestId('unsent-banner')).toBeNull();
    expect(s.drafts[report]).toBeUndefined();
  });

  it('words whose save keeps failing stop being sent, and are not told of, once the task is deleted here', async () => {
    const { s, report } = world();
    const real = api.patchTask;
    let down = true;
    vi.spyOn(api, 'patchTask').mockImplementation((...args) => (down ? Promise.reject({ code: 'io', message: 'the data file is locked' }) : real(...args)));
    const u = mouse();
    boot(s);
    await u.click(await screen.findByRole('button', { name: 'Edit Quarterly report' }));
    await u.click(box());
    await u.keyboard(' mine');
    await pass(1000);
    expect(kind()).toBe('failed');
    const { last } = await toFinal(u, 'Quarterly report');
    await u.click(button(last, 'Delete task'));
    await waitFor(() => expect(screen.queryByRole('article', { name: 'Quarterly report' })).toBeNull());
    const tries = vi.mocked(api.patchTask).mock.calls.length;
    down = false;
    await pass(ALL_RETRIES_MS);
    expect(vi.mocked(api.patchTask).mock.calls.length).toBe(tries);
    expect(noticesShown()).toEqual([]);
    expect(calls('keep_unsaved_words')).toHaveLength(0);
    expect(screen.queryByTestId('unsent-banner')).toBeNull();
    expect(s.drafts[report]).toBeUndefined();
  });

  it('a save in flight when the delete lands tells of no words and sends nothing more; the backend\'s own "task not found" is all that shows', async () => {
    const { s, report } = world();
    const real = api.patchTask;
    let release: () => void = () => undefined;
    vi.spyOn(api, 'patchTask').mockImplementation(
      (...args) =>
        new Promise((resolve, reject) => {
          release = () => void real(...args).then(resolve, reject);
        }),
    );
    const u = mouse();
    boot(s);
    await u.click(await screen.findByRole('button', { name: 'Edit Quarterly report' }));
    await u.click(box());
    await u.keyboard(' mine');
    await pass(1000);
    expect(vi.mocked(api.patchTask).mock.calls).toHaveLength(1);
    const { last } = await toFinal(u, 'Quarterly report');
    await u.click(button(last, 'Delete task'));
    await waitFor(() => expect(screen.queryByRole('article', { name: 'Quarterly report' })).toBeNull());
    release();
    await pass(5000);
    expect(noticesShown()).toEqual([]);
    expect(calls('keep_unsaved_words')).toHaveLength(0);
    expect(s.drafts[report]).toBeUndefined();
    expect(s.tasks.map((t) => t.id)).not.toContain(report);
    // The save was refused because the task is gone, and the page says that in the usual banner. Nothing else.
    expect(document.querySelector('.banner-error')).toHaveTextContent('task not found');
    expect(vi.mocked(api.patchTask).mock.calls).toHaveLength(1);
  });
});

describe('a dialog that opens over the delete dialogs', () => {
  /** Time away that arrives while the review is up: the time-away dialog opens by itself, on top. */
  async function awayOverReview(): Promise<{ u: User; s: MockState; away: HTMLElement; first: HTMLElement }> {
    const { s, report } = world();
    const u = mouse();
    boot(s);
    await u.click(trigger(await openDetails(u, 'Quarterly report')));
    const first = await review();
    s.gaps.push({ id: 'gap-late', segmentId: `${report}-s0`, taskId: report, deviceId: DEVICE_ID, start: '2026-03-10T09:10:00Z', end: '2026-03-10T09:40:00Z', kind: 'idle', decision: 'pending', decisionStamp: { at: '2026-03-10T09:40:00Z', by: DEVICE_ID } });
    s.revision += 1;
    await act(() => emit('state-changed'));
    const away = await screen.findByRole('dialog', { name: /You were away/ });
    // A dialog that opened by itself has not set up its keys yet.
    await pass(100);
    return { u, s, away, first };
  }

  it('keeps its own Enter: a key on its button still answers it, and nothing is deleted', async () => {
    const { u, away } = await awayOverReview();
    focus(within(away).getByRole('button', { name: /^Keep: Quarterly report/ }));
    await u.keyboard('{Enter}');
    await waitFor(() => expect(calls('decide_gap')).toHaveLength(1));
    expect(calls('decide_gap')[0]?.args).toMatchObject({ decision: 'keep' });
    expect(calls('delete_task')).toHaveLength(0);
  });

  it('keeps its own Esc: it closes, as it does over any other dialog', async () => {
    const { u } = await awayOverReview();
    await u.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog', { name: /You were away/ })).toBeNull());
    expect(calls('delete_task')).toHaveLength(0);
  });

  it('and the delete dialogs have their keys back once nothing is over them', async () => {
    const { s, u, away, first } = await awayOverReview();
    focus(within(away).getByRole('button', { name: /^Keep: Quarterly report/ }));
    await u.click(within(away).getByRole('button', { name: /^Keep: Quarterly report/ }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: /You were away/ })).toBeNull());
    expect(first).toBeInTheDocument();
    focus(within(first).getByRole('button', { name: 'Keep it' }));
    await u.keyboard('{Enter}');
    expect(first).toBeInTheDocument();
    await u.keyboard('{Escape}');
    expect(screen.queryByRole('dialog', { name: REVIEW })).toBeNull();
    expect(s.gaps.find((g) => g.id === 'gap-late')?.decision).toBe('keep');
  });
});

describe('a refusal and a second try', () => {
  it('a delete that goes through after a refused one leaves nothing of the refusal in the banner or beside the button', async () => {
    const { s } = world();
    const u = mouse();
    boot(s);
    const { details, last } = await toFinal(u, 'Quarterly report');
    s.failNext = ['delete_task'];
    await u.click(button(last, 'Delete task'));
    await waitFor(() => expect(document.querySelector('.banner-error')).toHaveTextContent('mock: delete_task failed'));
    expect(within(details).getByRole('alert')).toBeInTheDocument();
    // Again, from the start.
    await u.click(trigger(details));
    await pass(ARM_MS);
    await u.click(button(await review(), 'Continue'));
    const again = await final('Quarterly report');
    await pass(ARM_MS);
    await u.click(button(again, 'Delete task'));
    await waitFor(() => expect(screen.queryByRole('article', { name: 'Quarterly report' })).toBeNull());
    expect(document.querySelector('.banner-error')).toBeNull();
    expect(calls('delete_task')).toHaveLength(2);
  });

  it('what the page hears next outdates the refusal beside the button, and the banner keeps it', async () => {
    const { s } = world();
    const u = mouse();
    boot(s);
    const { details, last } = await toFinal(u, 'Quarterly report');
    s.failNext = ['delete_task'];
    await u.click(button(last, 'Delete task'));
    await waitFor(() => expect(within(details).getByRole('alert')).toBeInTheDocument());
    // Something changes elsewhere, and the page takes the new snapshot.
    s.revision += 1;
    await act(() => emit('state-changed'));
    await waitFor(() => expect(within(details).queryByRole('alert')).toBeNull());
    expect(document.querySelector('.banner-error')).toHaveTextContent('mock: delete_task failed');
  });
});

describe('Analysis after a delete', () => {
  it('filtered on the task, it is not left filtering on nothing once the task is gone', async () => {
    const { s, report } = world();
    const u = mouse();
    boot(s);
    await u.click(await screen.findByRole('tab', { name: 'Analysis' }));
    const pick = await screen.findByRole('combobox', { name: 'Task' });
    await u.selectOptions(pick, report);
    expect(pick).toHaveValue(report);
    expect(screen.queryByText('No logged time here')).toBeNull();
    const { last } = await toFinal(u, 'Quarterly report');
    await u.click(button(last, 'Delete task'));
    await waitFor(() => expect(screen.queryByRole('article', { name: 'Quarterly report' })).toBeNull());
    expect(screen.getByRole('combobox', { name: 'Task' })).toHaveValue('');
    // Inbox zero still has time in the week, and it shows.
    expect(screen.queryByText('No logged time here')).toBeNull();
    expect(screen.queryByText(/with these filters/)).toBeNull();
  });
});

describe('the dialogs say what works', () => {
  it('both tell a person at a keyboard that only a click or a tap goes on, and that Esc keeps the task', async () => {
    const { s } = world();
    const u = mouse();
    boot(s);
    const { last } = await toFinal(u, 'Quarterly report');
    expect(last).toHaveTextContent('Only a click or a tap goes on here. Enter and Space do nothing, and Esc keeps the task.');
    await u.keyboard('{Escape}');
    const details = screen.getByRole('dialog', { name: 'Details: Quarterly report' });
    await u.click(trigger(details));
    expect(await review()).toHaveTextContent('Only a click or a tap goes on here. Enter and Space do nothing, and Esc keeps the task.');
  });
});

describe('a task running on another of the computers', () => {
  /** Logo concepts, running on Office PC: its timer is open there, and this computer has none. */
  function onOfficePc(name: string | null = 'Office PC'): MockState {
    const s = demoState();
    const open = s.segments.find((x) => x.taskId === 't-logo' && x.end === null);
    const t = s.tasks.find((x) => x.id === 't-logo');
    if (!open || !t) throw new Error('seed');
    open.deviceId = 'other-device';
    t.runningElsewhere = name;
    return s;
  }

  it('can be deleted: the button is ready, and the review says where it runs, that its time so far goes too, and when its timer stops', async () => {
    const s = onOfficePc();
    const u = mouse();
    boot(s);
    const details = await openDetails(u, 'Logo concepts');
    expect(trigger(details)).toBeEnabled();
    expect(within(details).queryByTestId('delete-blocked')).toBeNull();
    await u.click(trigger(details));
    const dialog = await review();
    expect(dialog).toHaveTextContent("It is running on Office PC right now. The time it has logged there so far is deleted too, and Office PC's timer stops the next time it syncs.");
    // Plain: the person's own computer, never someone else's work.
    expect(dialog.textContent).not.toMatch(/someone|somebody|colleague|shared|teammate|another person/i);
    expect(button(dialog, 'Keep it')).toHaveFocus();
  });

  it('the last dialog says it again, and a click deletes it with its timer there', async () => {
    const s = onOfficePc();
    const open = s.segments.find((x) => x.taskId === 't-logo' && x.end === null);
    const u = mouse();
    boot(s);
    const { last } = await toFinal(u, 'Logo concepts');
    expect(last).toHaveTextContent("It is running on Office PC right now. The time it has logged there so far is deleted too, and Office PC's timer stops the next time it syncs.");
    await u.click(button(last, 'Delete task'));
    await waitFor(() => expect(screen.queryByRole('article', { name: 'Logo concepts' })).toBeNull());
    expect(calls('delete_task').map((c) => c.args)).toEqual([{ id: 't-logo' }]);
    expect(s.segments.some((x) => x.id === open?.id)).toBe(false);
    expect(s.tasks.map((t) => t.id)).not.toContain('t-logo');
  });

  it('can be deleted just the same once a request to pause it is waiting for that computer', async () => {
    const s = onOfficePc();
    call(s, 'request_remote_pause', { taskId: 't-logo' });
    const u = mouse();
    boot(s);
    expect(s.pauseRequests).toHaveLength(1);
    const details = await openDetails(u, 'Logo concepts');
    expect(trigger(details)).toBeEnabled();
    await u.click(trigger(details));
    expect(await review()).toHaveTextContent("It is running on Office PC right now.");
    await pass(ARM_MS);
    await u.click(button(await review(), 'Continue'));
    const last = await final('Logo concepts');
    await pass(ARM_MS);
    await u.click(button(last, 'Delete task'));
    await waitFor(() => expect(screen.queryByRole('article', { name: 'Logo concepts' })).toBeNull());
    expect(s.pauseRequests).toEqual([]);
    expect(calls('delete_task')).toHaveLength(1);
  });

  it('says your other PC when the snapshot has no name for it', async () => {
    const s = onOfficePc(null);
    const u = mouse();
    boot(s);
    const details = await openDetails(u, 'Logo concepts');
    expect(trigger(details)).toBeEnabled();
    await u.click(trigger(details));
    expect(await review()).toHaveTextContent("It is running on your other PC right now. The time it has logged there so far is deleted too, and that PC's timer stops the next time it syncs.");
  });

  it('is not said of a task that runs nowhere, and the mouse-only rule is the same as for any other', async () => {
    const { s } = world();
    const u = mouse();
    boot(s);
    await u.click(trigger(await openDetails(u, 'Quarterly report')));
    const dialog = await review();
    expect(dialog).not.toHaveTextContent('right now');
    await pass(ARM_MS);
    focus(button(dialog, 'Continue'));
    await u.keyboard('{Enter}');
    await u.keyboard(' ');
    expect(dialog).toBeInTheDocument();
  });

  it('with a timer open on this computer as well, it is still held back', async () => {
    const s = onOfficePc();
    s.segments.push({ id: 'here-too', taskId: 't-logo', deviceId: DEVICE_ID, start: '2026-03-12T15:00:00Z', end: null, provisionalEnd: null });
    const u = mouse();
    boot(s);
    const details = await openDetails(u, 'Logo concepts');
    expect(trigger(details)).toBeDisabled();
    expect(within(details).getByTestId('delete-blocked')).toHaveTextContent('This task is running. Pause or stop it first, then delete it.');
  });
});
