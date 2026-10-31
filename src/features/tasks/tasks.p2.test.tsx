import { clearMocks } from '@tauri-apps/api/mocks';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { boot as bootApp, polyfillDom } from '../../components/testKit';
import { subtaskItems } from '../../lib/subtasks';
import type { RichDoc } from '../../lib/types';
import { demoP2State } from '../../mocks/demoSeed';
import { DEVICE_ID, emptyState, type MockState } from '../../mocks/ipcMock';

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
const cardOf = (name: string) => screen.findByRole('article', { name }).then((el) => within(el));
const stamp = { at: '2026-02-01T00:00:00Z', by: DEVICE_ID };

function coldWithProject(): MockState {
  const s = emptyState('2026-03-12T15:20:00Z');
  s.projects.push({ id: 'p1', name: 'Brand refresh', color: '#2563eb', archived: false, billable: true, budgetHours: null, clientZone: null, createdAt: '2026-01-01T00:00:00Z' });
  return s;
}

const itemDoc = (items: { text: string; id?: string; checked?: boolean }[]): RichDoc => ({
  type: 'doc',
  content: [
    {
      type: 'taskList',
      content: items.map((i) => ({
        type: 'taskItem',
        attrs: { checked: i.checked ?? false, ...(i.id ? { subtaskId: i.id } : {}) },
        content: [{ type: 'paragraph', content: [{ type: 'text', text: i.text }] }],
      })),
    },
  ],
});

describe('tags on the new-task form', () => {
  it('a cold start with live tags needs one: Start stays disabled with the reason, then works', async () => {
    const user = userEvent.setup();
    boot(coldWithProject());
    await user.click(await screen.findByRole('button', { name: 'New task' }));
    const form = screen.getByRole('form', { name: 'New task' });
    await user.type(within(form).getByRole('textbox', { name: 'Task name' }), 'Needs a tag');
    await user.selectOptions(within(form).getByRole('combobox', { name: 'Project' }), 'p1');
    await user.type(within(form).getByRole('textbox', { name: 'Description' }), 'Some text');
    expect(within(form).getByRole('button', { name: 'Start' })).toBeDisabled();
    expect(within(form).getByText('To start, enter at least one tag.')).toBeVisible();
    expect(within(form).getByText('Tags are required for the first start after launch.')).toBeVisible();
    await user.click(within(form).getByRole('checkbox', { name: 'Admin' }));
    await user.click(within(form).getByRole('checkbox', { name: 'Concept' }));
    expect(within(form).getByRole('button', { name: 'Start' })).toBeEnabled();
    expect(within(form).queryByText(/To start, enter/)).toBeNull();
    await user.click(within(form).getByRole('checkbox', { name: 'Admin' })); // multi-select: one can go again
    await user.click(within(form).getByRole('button', { name: 'Start' }));
    await waitFor(() => expect(state.warm).toBe(true));
    expect(calls('create_task')[0]).toMatchObject({ input: { name: 'Needs a tag', tags: ['tag-concept'] } });
  });

  it('with every tag deleted the backend no longer lists tags, so a cold start works without one', async () => {
    const user = userEvent.setup();
    const s = coldWithProject();
    for (const t of s.tags) t.deleted = true;
    boot(s);
    await user.click(await screen.findByRole('button', { name: 'New task' }));
    const form = screen.getByRole('form', { name: 'New task' });
    expect(within(form).queryByRole('checkbox')).toBeNull();
    expect(within(form).getByText(/No tags yet/)).toBeVisible();
    await user.type(within(form).getByRole('textbox', { name: 'Task name' }), 'No tags exist');
    await user.selectOptions(within(form).getByRole('combobox', { name: 'Project' }), 'p1');
    await user.type(within(form).getByRole('textbox', { name: 'Description' }), 'Some text');
    expect(within(form).queryByText(/To start, enter/)).toBeNull();
    await user.click(within(form).getByRole('button', { name: 'Start' }));
    await waitFor(() => expect(state.warm).toBe(true));
    expect(state.tasks[0]?.tags).toEqual([]);
  });

  it('a warm start prefills the tags of the copied task and resets its task list to unticked, with no time', async () => {
    const user = userEvent.setup();
    boot(demoP2State());
    await user.click(await screen.findByRole('button', { name: 'New task' }));
    const form = screen.getByRole('form', { name: 'New task' });
    expect(within(form).getByTestId('copy-note')).toBeVisible();
    expect(within(form).getByRole('checkbox', { name: 'Concept' })).toBeChecked();
    for (const other of ['Revision', 'Client call', 'Admin']) expect(within(form).getByRole('checkbox', { name: other })).not.toBeChecked();
    await user.click(within(form).getByRole('button', { name: 'Save draft' }));
    await waitFor(() => expect(calls('create_task')).toHaveLength(1));
    const made = state.tasks.find((t) => t.state === 'draft' && t.name === 'Logo concepts');
    expect(made?.tags).toEqual(['tag-concept']);
    const items = subtaskItems(made?.description);
    expect(items.map((i) => [i.text, i.checked])).toEqual([['Moodboard', false], ['Sketches', false], ['Final artwork', false]]);
    // Fresh ids: none of the source task's ids, so no tracked time comes along.
    expect(items.map((i) => i.id).filter((id) => ['st-moodboard', 'st-sketches', 'st-final'].includes(id))).toEqual([]);
    const source = state.tasks.find((t) => t.id === 't-logo');
    expect(subtaskItems(source?.description).find((i) => i.text === 'Moodboard')?.checked).toBe(true); // the original is untouched
    // The new draft shows the same tag and no tracked time.
    await waitFor(() => expect(screen.getAllByRole('article', { name: 'Logo concepts' })).toHaveLength(2));
  });

  it('drops a tag that was deleted since it was copied', async () => {
    const user = userEvent.setup();
    const s = demoP2State();
    const t = s.tags.find((x) => x.id === 'tag-concept');
    if (t) t.deleted = true;
    boot(s);
    await user.click(await screen.findByRole('button', { name: 'New task' }));
    const form = screen.getByRole('form', { name: 'New task' });
    expect(within(form).queryByRole('checkbox', { name: 'Concept' })).toBeNull();
    for (const box of within(form).getAllByRole('checkbox')) expect(box).not.toBeChecked();
  });
});

describe('tags on a card and in the inline editor', () => {
  it('shows each tag as a chip with its name and a readable colour pair', async () => {
    boot(demoP2State());
    const guide = await cardOf('Brand guidelines');
    const chips = guide.getAllByTestId('tag-chip');
    expect(chips.map((c) => c.textContent)).toEqual(['Concept', 'Revision']);
    expect([chips[0]?.style.backgroundColor, chips[0]?.style.color]).toEqual(['rgb(124, 58, 237)', 'rgb(255, 255, 255)']);
    expect([chips[1]?.style.backgroundColor, chips[1]?.style.color]).toEqual(['rgb(15, 118, 110)', 'rgb(255, 255, 255)']);
    expect(within(await screen.findByRole('article', { name: 'Social templates' })).queryByRole('list', { name: 'Tags' })).toBeNull();
  });

  it('a chip on a light tag uses dark text', async () => {
    const s = demoP2State();
    const tag = s.tags.find((t) => t.id === 'tag-admin');
    if (tag) tag.color = '#fde047';
    boot(s);
    const mail = await cardOf('Email and invoices');
    const chip = mail.getByTestId('tag-chip');
    expect([chip.style.backgroundColor, chip.style.color]).toEqual(['rgb(253, 224, 71)', 'rgb(0, 0, 0)']);
  });

  it('autosaves tag changes with patch_task, and clearing every tag sends an empty list', async () => {
    const user = userEvent.setup();
    boot(demoP2State());
    await user.click(await screen.findByRole('button', { name: 'Edit Brand guidelines' }));
    const form = screen.getByRole('form', { name: 'Editing Brand guidelines' });
    expect(within(form).getByRole('checkbox', { name: 'Concept' })).toBeChecked();
    expect(within(form).getByRole('checkbox', { name: 'Revision' })).toBeChecked();

    await user.click(within(form).getByRole('checkbox', { name: 'Revision' }));
    await waitFor(() => expect(calls('patch_task')).toHaveLength(1), { timeout: 2000 });
    expect(calls('patch_task')[0]).toEqual({ id: 't-guide', patch: { tags: ['tag-concept'] } });
    await waitFor(() => expect(within(form).getByTestId('save-state')).toHaveTextContent('Saved'));

    await user.click(within(form).getByRole('checkbox', { name: 'Concept' }));
    await waitFor(() => expect(calls('patch_task')).toHaveLength(2), { timeout: 2000 });
    expect(calls('patch_task')[1]).toEqual({ id: 't-guide', patch: { tags: [] } });
    expect(state.tasks.find((t) => t.id === 't-guide')?.tags).toEqual([]);
    await waitFor(() => expect(within(screen.getByRole('article', { name: 'Brand guidelines' })).queryByRole('list', { name: 'Tags' })).toBeNull());

    await user.click(within(form).getByRole('checkbox', { name: 'Admin' }));
    await waitFor(() => expect(calls('patch_task')).toHaveLength(3), { timeout: 2000 });
    expect(calls('patch_task')[2]).toEqual({ id: 't-guide', patch: { tags: ['tag-admin'] } });
    await waitFor(() => expect(within(screen.getByRole('article', { name: 'Brand guidelines' })).getByTestId('tag-chip')).toHaveTextContent('Admin'));
  });

  it('a draft that lacks a tag cannot start while cold, and gains the right once a tag is saved', async () => {
    const user = userEvent.setup();
    const s = coldWithProject();
    s.tasks.push({ id: 'd1', name: 'Needs tag', projectId: 'p1', description: itemDoc([{ text: 'x' }]), state: 'draft', pauseReason: null, createdAt: '2026-03-01T00:00:00Z', stoppedAt: null, runningElsewhere: null, continuedFrom: null });
    boot(s);
    const c = within(await screen.findByRole('article', { name: 'Needs tag' }));
    expect(c.getByRole('button', { name: 'Start' })).toBeDisabled();
    expect(c.getByText(/The first start after launch needs tags/)).toBeVisible();
    await user.click(c.getByRole('button', { name: 'Edit Needs tag' }));
    await user.click(screen.getByRole('checkbox', { name: 'Concept' }));
    await waitFor(() => expect(c.getByRole('button', { name: 'Start' })).toBeEnabled(), { timeout: 3000 });
  });
});

describe('templates', () => {
  it('fills the form from a template: name, project, tags and unticked items, without a draft being created', async () => {
    const user = userEvent.setup();
    boot(demoP2State());
    await user.click(await screen.findByRole('button', { name: 'New task' }));
    const form = screen.getByRole('form', { name: 'New task' });
    await user.selectOptions(within(form).getByRole('combobox', { name: 'From template' }), 'tpl-logo');
    expect(within(form).getByRole('textbox', { name: 'Task name' })).toHaveValue('Logo job'); // the copied name was not typed by the user
    expect(within(form).getByRole('combobox', { name: 'Project' })).toHaveValue('p-brand');
    expect(within(form).getByRole('checkbox', { name: 'Concept' })).toBeChecked();
    expect(within(form).getByRole('checkbox', { name: 'Revision' })).not.toBeChecked();
    expect(within(form).getByRole('textbox', { name: 'Description' })).toHaveTextContent('Three directions, one round of changes.');
    expect(within(form).queryByTestId('copy-note')).toBeNull();
    expect(within(form).getByRole('status', { name: '' })).toHaveTextContent('Filled in from the template “Logo job”');
    expect(calls('create_task')).toEqual([]); // the form holds it; Cancel would leave nothing behind
    await user.click(within(form).getByRole('button', { name: 'Save draft' }));
    await waitFor(() => expect(calls('create_task')).toHaveLength(1));
    expect(calls('create_task')[0]).toMatchObject({ input: { name: 'Logo job', projectId: 'p-brand', tags: ['tag-concept'] } });
    const made = state.tasks.find((t) => t.name === 'Logo job');
    expect(subtaskItems(made?.description).map((i) => [i.text, i.checked])).toEqual([['Moodboard', false], ['Sketches', false], ['Final artwork', false]]);
  });

  it('keeps a name the user typed', async () => {
    const user = userEvent.setup();
    boot(demoP2State());
    await user.click(await screen.findByRole('button', { name: 'New task' }));
    const form = screen.getByRole('form', { name: 'New task' });
    const name = within(form).getByRole('textbox', { name: 'Task name' });
    await user.clear(name);
    await user.type(name, 'My own name');
    await user.selectOptions(within(form).getByRole('combobox', { name: 'From template' }), 'tpl-logo');
    expect(name).toHaveValue('My own name');
    expect(within(form).getByRole('combobox', { name: 'Project' })).toHaveValue('p-brand');
  });

  it('a template without a project asks for one before the task can start', async () => {
    const user = userEvent.setup();
    const s = coldWithProject();
    s.templates.push({ id: 'tpl-a', name: 'Admin day', projectId: null, description: itemDoc([{ text: 'Invoices' }]), tags: ['tag-admin'], deleted: false, stamp });
    boot(s);
    await user.click(await screen.findByRole('button', { name: 'New task' }));
    const form = screen.getByRole('form', { name: 'New task' });
    await user.selectOptions(within(form).getByRole('combobox', { name: 'From template' }), 'tpl-a');
    expect(within(form).getByRole('textbox', { name: 'Task name' })).toHaveValue('Admin day');
    expect(within(form).getByRole('combobox', { name: 'Project' })).toHaveValue('');
    expect(within(form).getByText(/It has no project, so choose a project/)).toBeVisible();
    expect(within(form).getByRole('button', { name: 'Start' })).toBeDisabled();
    expect(within(form).getByText('To start, enter a project.')).toBeVisible();
    await user.selectOptions(within(form).getByRole('combobox', { name: 'Project' }), 'p1');
    expect(within(form).getByRole('button', { name: 'Start' })).toBeEnabled();
  });

  it('offers no template choice when there are none', async () => {
    const user = userEvent.setup();
    boot(coldWithProject());
    await user.click(await screen.findByRole('button', { name: 'New task' }));
    expect(within(screen.getByRole('form', { name: 'New task' })).queryByRole('combobox', { name: 'From template' })).toBeNull();
  });

  it('Save as template stores name, project, tags and description, without ticks or ids', async () => {
    const user = userEvent.setup();
    boot(demoP2State());
    await user.click(await screen.findByRole('button', { name: 'Edit Logo concepts' }));
    const form = screen.getByRole('form', { name: 'Editing Logo concepts' });
    await user.click(within(form).getByRole('button', { name: 'Save as template' }));
    await waitFor(() => expect(calls('save_template')).toHaveLength(1));
    expect(calls('save_template')[0]).toMatchObject({ input: { id: null, name: 'Logo concepts', projectId: 'p-brand', tags: ['tag-concept'] } });
    const saved = state.templates.find((t) => t.name === 'Logo concepts');
    expect(saved).toBeDefined();
    expect(subtaskItems(saved?.description).map((i) => [i.text, i.checked, i.id])).toEqual([['Moodboard', false, ''], ['Sketches', false, ''], ['Final artwork', false, '']]);
    expect(await within(form).findByText(/Saved as template “Logo concepts”/)).toBeVisible();
    // The task itself is unchanged.
    expect(subtaskItems(state.tasks.find((t) => t.id === 't-logo')?.description).find((i) => i.text === 'Moodboard')?.checked).toBe(true);
    // And it shows up in the form's choice.
    await user.click(screen.getByRole('button', { name: 'Done' }));
    await user.click(screen.getByRole('button', { name: 'New task' }));
    const options = within(screen.getByRole('form', { name: 'New task' })).getAllByRole('option').map((o) => o.textContent);
    expect(options).toContain('Logo concepts');
  });
});

describe('subtasks', () => {
  it('lists each item with its time, marks the active one and shows time with no subtask', async () => {
    boot(demoP2State());
    const logo = await cardOf('Logo concepts');
    const region = within(logo.getByRole('region', { name: 'Subtasks' }));
    const row = (text: string) => within(region.getByText(text).closest('li') as HTMLElement);
    expect(row('Moodboard').getByText('9h 40m')).toBeVisible();
    expect(row('Sketches').getByText('Active')).toBeVisible();
    expect(row('Sketches').getByText(/^10h 15m$/)).toBeVisible();
    expect(row('Final artwork').getByText('0s')).toBeVisible();
    expect(row('Time with no subtask').getByText('0s')).toBeVisible();
    // Exactly one is active.
    expect(region.getAllByText('Active')).toHaveLength(1);
    expect(region.getAllByRole('button', { name: 'Make active' })).toHaveLength(2);
    expect(region.getByRole('button', { name: 'No subtask' })).toBeVisible();
    // The total is the items plus the time with no subtask.
    expect(region.getByTestId('subtask-total')).toHaveTextContent('Total worked 19h 55m');
    expect(region.getByText(/19h 55m on items plus 0s with no subtask makes 19h 55m/)).toBeVisible();
    expect(region.getByText(/Switching now splits the running time at this moment/)).toBeVisible();
  });

  it('Make active on a running task splits the running time at now and moves the marker', async () => {
    const user = userEvent.setup();
    boot(demoP2State());
    const logo = await cardOf('Logo concepts');
    const region = within(logo.getByRole('region', { name: 'Subtasks' }));
    const final = region.getByText('Final artwork').closest('li') as HTMLElement;
    await user.click(within(final).getByRole('button', { name: 'Make active' }));
    await waitFor(() => expect(calls('set_active_subtask')).toEqual([{ taskId: 't-logo', subtaskId: 'st-final' }]));
    await waitFor(() => expect(within(final).getByText('Active')).toBeVisible());
    expect(final).toHaveFocus();
    expect(region.getAllByText('Active')).toHaveLength(1);
    expect(within(region.getByText('Sketches').closest('li') as HTMLElement).getByRole('button', { name: 'Make active' })).toBeVisible();
    // The backend closed the running segment and opened one for the new item.
    const own = state.segments.filter((x) => x.taskId === 't-logo' && x.start >= '2026-03-12T14:00:00Z');
    const open = own.filter((x) => x.end === null);
    expect(open).toHaveLength(1);
    expect(open[0]?.subtaskId).toBe('st-final');
    expect(own.some((x) => x.end !== null && x.subtaskId === 'st-sketches' && x.end === open[0]?.start)).toBe(true);
    // Sketches keeps what it had; the total did not change.
    expect(within(region.getByText('Sketches').closest('li') as HTMLElement).getByText(/^10h 15m$/)).toBeVisible();
    expect(region.getByTestId('subtask-total')).toHaveTextContent('Total worked 19h 55m');
  });

  it('No subtask clears the active item, and time then lands in the no-subtask total', async () => {
    const user = userEvent.setup();
    boot(demoP2State());
    const logo = await cardOf('Logo concepts');
    const region = within(logo.getByRole('region', { name: 'Subtasks' }));
    await user.click(region.getByRole('button', { name: 'No subtask' }));
    await waitFor(() => expect(calls('set_active_subtask')).toEqual([{ taskId: 't-logo', subtaskId: null }]));
    const none = region.getByText('Time with no subtask').closest('li') as HTMLElement;
    await waitFor(() => expect(within(none).getByText('Active')).toBeVisible());
    expect(region.getAllByText('Active')).toHaveLength(1);
    expect(region.getAllByRole('button', { name: 'Make active' })).toHaveLength(3);
    expect(none).toHaveFocus();
  });

  it('an item that was only just typed has no id, so it can only be made active once saved', async () => {
    const s = demoP2State();
    s.tasks.push({ id: 't-new', name: 'Fresh list', projectId: 'p-brand', description: itemDoc([{ text: 'Saved one', id: 'st-ok' }, { text: 'Just typed' }]), state: 'paused', pauseReason: { kind: 'user' }, createdAt: '2026-03-12T08:00:00Z', stoppedAt: null, runningElsewhere: null, continuedFrom: null });
    boot(s);
    const c = await cardOf('Fresh list');
    const region = within(c.getByRole('region', { name: 'Subtasks' }));
    const typed = within(region.getByText('Just typed').closest('li') as HTMLElement);
    expect(typed.getByRole('button', { name: 'Make active' })).toBeDisabled();
    expect(typed.getByText('Saved items only')).toBeVisible();
    expect(within(region.getByText('Saved one').closest('li') as HTMLElement).getByRole('button', { name: 'Make active' })).toBeEnabled();
    expect(region.getByText(/New time goes to the active one\.$/)).toBeVisible(); // a paused task is not "splitting"
  });

  it('a task with no task-list items has no subtask section', async () => {
    boot(demoP2State());
    const guide = await cardOf('Brand guidelines');
    expect(guide.queryByRole('region', { name: 'Subtasks' })).toBeNull();
  });
});

describe('time on a card', () => {
  it('shows billed and unbilled time after a summary, with the pauses a total includes', async () => {
    boot(demoP2State());
    const home = await cardOf('Homepage layout');
    expect(home.getByTestId('billed-line')).toHaveTextContent('Billed 12h 10m, unbilled 18h 25m');
    expect(home.getByTestId('billed-line')).not.toHaveTextContent('billable pauses');
    const logo = await cardOf('Logo concepts');
    expect(logo.getByTestId('billed-line')).toHaveTextContent(/^Billed 0s, unbilled 20h 2\dm, includes 30m billable pauses$/);
  });

  it('shows pending time away as unconfirmed and keeps it out of every total and the live clock', async () => {
    boot(demoP2State());
    const logo = await cardOf('Logo concepts');
    expect(logo.getByText('Unconfirmed: not counted until you confirm')).toBeVisible();
    expect(logo.getByTestId('unconfirmed-line')).toHaveTextContent('30m');
    // Pending 14:20 to 14:50 is cut out: the open piece began at 14:50, so the session is 30 minutes, not 80.
    // The app's clock may sit a second behind the mock's, so 29:5x counts too.
    await waitFor(() => expect(document.querySelector('.ticker-clock')?.textContent ?? '').toMatch(/^0:(29:5\d|30:0\d)$/));
    expect(within(await screen.findByRole('article', { name: 'Homepage layout' })).queryByTestId('unconfirmed-line')).toBeNull();
  });

  it('shows thinking time as worked time', async () => {
    boot(demoP2State());
    const box = await cardOf('Box dieline');
    expect(box.getByTestId('thinking-line')).toHaveTextContent('Thinking time 25m, counted as worked time');
  });

  it('the ticker keeps a billable pause out of Exact and in Billable, and says so', async () => {
    boot(demoP2State());
    const logo = await cardOf('Logo concepts');
    const exact = logo.getByText('Today, exact').parentElement as HTMLElement;
    const billable = logo.getByText(/^Today, billable/).parentElement as HTMLElement;
    // Today in Lisbon: 40m after midnight, 85m, 20m and the open piece's 30m, with the 30 minute pause apart.
    expect(within(exact).getByText(/^2h 5[45]m/)).toBeVisible(); // 2h 55m, or 54m when the clock sits a second behind
    expect(within(billable).getByText(/^3h 30m/)).toBeVisible(); // 175m + 30m pause = 205m, rounded up to 210m
    expect(within(billable).getByText('includes 30m billable pauses')).toBeVisible();
    expect(within(exact).queryByText(/billable pauses/)).toBeNull();
  });

  it('the ticker names thinking time inside Exact', async () => {
    const s = demoP2State();
    // Turn the pending gap into thinking time: it joins the pieces as worked time.
    const gap = s.gaps.find((g) => g.id === 'gap-pending');
    if (gap) gap.decision = 'thinking';
    boot(s);
    const logo = await cardOf('Logo concepts');
    const exact = logo.getByText('Today, exact').parentElement as HTMLElement;
    expect(within(exact).getByText(/^3h 2[45]m/)).toBeVisible(); // 175m + 30m
    expect(within(exact).getByText('includes 30m thinking')).toBeVisible();
    expect(logo.queryByTestId('unconfirmed-line')).toBeNull();
  });

  function fixedFeeRunning(): MockState {
    const s = demoP2State();
    const t = s.tasks.find((x) => x.id === 't-print');
    if (t) {
      t.state = 'running';
      t.stoppedAt = null;
    }
    s.segments.push({ id: 'seg-print-open', taskId: 't-print', deviceId: DEVICE_ID, start: '2026-03-12T14:30:00Z', end: null, provisionalEnd: null });
    return s;
  }

  it('a fixed-fee project says Fixed fee with the fee instead of No rate set', async () => {
    boot(fixedFeeRunning());
    const c = await cardOf('Print proofs');
    expect(c.getByText(/^Fixed fee: /)).toHaveTextContent('Fixed fee: €1,000.00. Hourly earnings are not counted.');
    expect(c.queryByText(/No rate set/)).toBeNull();
    expect(c.queryByText('Billable now')).toBeNull();
  });

  it('Hide earnings masks the fee', async () => {
    const s = fixedFeeRunning();
    s.hideEarnings = true;
    boot(s);
    const c = await cardOf('Print proofs');
    expect(c.getByText(/^Fixed fee: /)).toHaveTextContent('Fixed fee: ••••.');
    expect(c.queryByText(/1,000/)).toBeNull();
  });
});
