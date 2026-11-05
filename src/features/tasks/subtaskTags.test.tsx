// The tags of a subtask on the task card: the button on each item, the checklist it opens, with the mouse and the keyboard,
// "Select all / Deselect all" and "Same as task", read-only mode, the refusal when the stored tags moved on, and changes
// that follow each other. The mock answers as the core does (src/mocks/subtaskTagsParity.test.ts runs the shared table).
import { emit } from '@tauri-apps/api/event';
import { clearMocks } from '@tauri-apps/api/mocks';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { readOnlyMessage } from '../../app/useReadOnly';
import { boot as bootApp, polyfillDom } from '../../components/testKit';
import { api } from '../../lib/api';
import type { SubtaskTagsReply } from '../../lib/types';
import { demoP2State, subtaskDoc } from '../../mocks/demoSeed';
import { DEVICE_ID, seedLease, type MockState } from '../../mocks/ipcMock';
import { CONFLICT_NOTE, allToggled, tickedOf, toggled } from './SubtaskTags';

beforeEach(polyfillDom);
afterEach(() => {
  clearMocks();
  vi.restoreAllMocks();
});

let state: MockState;
const calls = (cmd: string) => state.calls.filter((c) => c.cmd === cmd).map((c) => c.args as Record<string, unknown>);
const card = async (name: string) => within(await screen.findByRole('article', { name }));
const SAME_STAMP = { at: '2026-02-01T00:00:00Z', by: DEVICE_ID };

/** The running task of the demo, with three of the starter tags: Concept, Revision and Admin. Its list is Moodboard, Sketches, Final artwork. */
function world(tags = ['tag-concept', 'tag-revision', 'tag-admin']): MockState {
  const s = demoP2State();
  const logo = s.tasks.find((t) => t.id === 't-logo');
  if (!logo) throw new Error('the demo has no Logo concepts');
  logo.tags = tags;
  // The demo's time away waiting for an answer opens a dialog on load, and a dialog takes Escape and the focus.
  s.gaps = s.gaps.filter((g) => g.decision !== 'pending');
  state = s;
  return s;
}
const boot = (s: MockState) => bootApp(s);
const storedOf = (id = 'st-sketches') => state.tasks.find((t) => t.id === 't-logo')?.subtaskTags?.[id];

/** The button on an item's row, found by what it says: "Tags for Sketches: Same as task". */
const tagsButton = (c: ReturnType<typeof within>, item: string, now: string) => c.getByRole('button', { name: `Tags for ${item}: ${now}` });
const dialogOf = (c: ReturnType<typeof within>, item: string) => within(c.getByRole('dialog', { name: `Tags for ${item}` }));

describe('the rules of the checklist', () => {
  const live = ['a', 'b', 'c'];

  it('ticks every tag of the task while an item is on "Same as task", and its own list otherwise, in the task’s order', () => {
    expect(tickedOf(live, null)).toEqual(['a', 'b', 'c']);
    expect(tickedOf(live, ['c', 'a'])).toEqual(['a', 'c']);
    expect(tickedOf(live, [])).toEqual([]);
    // A tag that no longer exists is not shown ticked.
    expect(tickedOf(live, ['gone', 'b'])).toEqual(['b']);
  });

  it('ticks and unticks one tag, giving a list in the task’s order; the last one unticked is No tag, not a reset', () => {
    expect(toggled(live, null, 'b')).toEqual(['a', 'c']);
    expect(toggled(live, ['a', 'c'], 'b')).toEqual(['a', 'b', 'c']);
    expect(toggled(live, ['c'], 'a')).toEqual(['a', 'c']);
    expect(toggled(live, ['b'], 'b')).toEqual([]);
  });

  it('has one button for all: everything ticked unticks all, anything else ticks all as a list of every tag', () => {
    expect(allToggled(live, null)).toEqual([]);
    expect(allToggled(live, live)).toEqual([]);
    expect(allToggled(live, ['a'])).toEqual(['a', 'b', 'c']);
    expect(allToggled(live, [])).toEqual(['a', 'b', 'c']);
  });
});

describe('the button on each item of the task card', () => {
  it('says "Same as task" for every item, and is a button that opens a list', async () => {
    boot(world());
    const c = await card('Logo concepts');
    for (const item of ['Moodboard', 'Sketches', 'Final artwork']) {
      const button = tagsButton(c, item, 'Same as task');
      expect(button).toHaveTextContent('Same as task');
      expect(button).toHaveAttribute('aria-haspopup', 'dialog');
      expect(button).toHaveAttribute('aria-expanded', 'false');
    }
    expect(c.queryByRole('dialog')).toBeNull();
  });

  it('shows the item’s own tags as chips once it has some, and "No tag" for none', async () => {
    const s = world();
    const logo = s.tasks.find((t) => t.id === 't-logo');
    if (logo) logo.subtaskTags = { 'st-sketches': { tags: ['tag-concept', 'tag-admin'], stamp: SAME_STAMP }, 'st-final': { tags: [], stamp: SAME_STAMP } };
    boot(s);
    const c = await card('Logo concepts');
    const sketches = tagsButton(c, 'Sketches', 'Concept, Admin');
    expect(within(sketches).getAllByText(/^(Concept|Admin)$/).map((e) => e.textContent)).toEqual(['Concept', 'Admin']);
    expect(tagsButton(c, 'Final artwork', 'No tag')).toHaveTextContent('No tag');
    expect(tagsButton(c, 'Moodboard', 'Same as task')).toBeVisible();
  });

  it('is not there for a task with no tags, as there is nothing to choose from', async () => {
    const none = world([]);
    boot(none);
    const c = await card('Logo concepts');
    expect(c.getByText('Sketches')).toBeVisible();
    expect(c.queryByRole('button', { name: /^Tags for/ })).toBeNull();
  });

  it('is not there for an item that is not saved yet, which has no id to carry tags', async () => {
    const s = world();
    const logo = s.tasks.find((t) => t.id === 't-logo');
    if (logo) logo.description = subtaskDoc([{ id: 'st-saved', text: 'Saved item' }, { text: 'Typed just now' }]);
    boot(s);
    const c = await card('Logo concepts');
    expect(c.getByRole('button', { name: 'Tags for Saved item: Same as task' })).toBeVisible();
    expect(c.queryByRole('button', { name: /^Tags for Typed just now/ })).toBeNull();
    expect(c.getByText('Saved items only')).toBeVisible();
  });
});

describe('choosing with the mouse', () => {
  it('opens a list with Same as task, one button for all, and the task’s tags ticked while the item follows the task', async () => {
    const user = userEvent.setup();
    boot(world());
    const c = await card('Logo concepts');
    await user.click(tagsButton(c, 'Sketches', 'Same as task'));
    const list = dialogOf(c, 'Sketches');
    expect(list.getByRole('button', { name: 'Same as task' })).toHaveAttribute('aria-pressed', 'true');
    expect(list.getByRole('button', { name: 'Deselect all' })).toBeVisible();
    for (const tag of ['Concept', 'Revision', 'Admin']) expect(list.getByRole('checkbox', { name: tag })).toBeChecked();
    // A tag the task does not have is not offered.
    expect(list.queryByRole('checkbox', { name: 'Client call' })).toBeNull();
    expect(tagsButton(c, 'Sketches', 'Same as task')).toHaveAttribute('aria-expanded', 'true');
  });

  it('unticking a tag gives the item the rest, saved at once and compared with what the row showed', async () => {
    const user = userEvent.setup();
    boot(world());
    const c = await card('Logo concepts');
    await user.click(tagsButton(c, 'Sketches', 'Same as task'));
    await user.click(dialogOf(c, 'Sketches').getByRole('checkbox', { name: 'Revision' }));
    await waitFor(() => expect(calls('set_subtask_tags')).toHaveLength(1));
    expect(calls('set_subtask_tags')[0]).toEqual({ taskId: 't-logo', subtaskId: 'st-sketches', tags: ['tag-concept', 'tag-admin'], expected: { tags: null } });
    expect(storedOf()?.tags).toEqual(['tag-concept', 'tag-admin']);
    // The row follows the store, the list stays open, and its siblings are untouched.
    await waitFor(() => expect(tagsButton(c, 'Sketches', 'Concept, Admin')).toBeVisible());
    expect(dialogOf(c, 'Sketches').getByRole('checkbox', { name: 'Revision' })).not.toBeChecked();
    expect(dialogOf(c, 'Sketches').getByRole('button', { name: 'Same as task' })).toHaveAttribute('aria-pressed', 'false');
    expect(tagsButton(c, 'Moodboard', 'Same as task')).toBeVisible();
    expect(storedOf('st-moodboard')).toBeUndefined();
  });

  it('keeps a hand-picked list as the task gains a tag: the item does not follow the task any more', async () => {
    const user = userEvent.setup();
    boot(world(['tag-concept', 'tag-revision']));
    const c = await card('Logo concepts');
    await user.click(tagsButton(c, 'Sketches', 'Same as task'));
    const list = dialogOf(c, 'Sketches');
    await user.click(list.getByRole('button', { name: 'Deselect all' }));
    await user.click(list.getByRole('button', { name: 'Select all' }));
    await waitFor(() => expect(calls('set_subtask_tags')).toHaveLength(2));
    // Every tag, as a list: not "Same as task".
    expect(calls('set_subtask_tags')[1]).toMatchObject({ tags: ['tag-concept', 'tag-revision'], expected: { tags: [] } });
    expect(storedOf()?.tags).toEqual(['tag-concept', 'tag-revision']);
  });

  it('"Deselect all" makes the item No tag, and the same button then says "Select all"', async () => {
    const user = userEvent.setup();
    boot(world());
    const c = await card('Logo concepts');
    await user.click(tagsButton(c, 'Sketches', 'Same as task'));
    const list = dialogOf(c, 'Sketches');
    await user.click(list.getByRole('button', { name: 'Deselect all' }));
    await waitFor(() => expect(tagsButton(c, 'Sketches', 'No tag')).toHaveTextContent('No tag'));
    expect(calls('set_subtask_tags')[0]).toMatchObject({ tags: [], expected: { tags: null } });
    expect(storedOf()?.tags).toEqual([]);
    expect(list.queryByRole('button', { name: 'Deselect all' })).toBeNull();
    for (const tag of ['Concept', 'Revision', 'Admin']) expect(list.getByRole('checkbox', { name: tag })).not.toBeChecked();
    await user.click(list.getByRole('button', { name: 'Select all' }));
    await waitFor(() => expect(storedOf()?.tags).toEqual(['tag-concept', 'tag-revision', 'tag-admin']));
    expect(list.getByRole('button', { name: 'Deselect all' })).toBeVisible();
  });

  it('"Same as task" puts an item back, and the task’s tags apply to it from then on', async () => {
    const user = userEvent.setup();
    const s = world();
    const logo = s.tasks.find((t) => t.id === 't-logo');
    if (logo) logo.subtaskTags = { 'st-sketches': { tags: ['tag-revision'], stamp: SAME_STAMP } };
    boot(s);
    const c = await card('Logo concepts');
    await user.click(tagsButton(c, 'Sketches', 'Revision'));
    await user.click(dialogOf(c, 'Sketches').getByRole('button', { name: 'Same as task' }));
    await waitFor(() => expect(tagsButton(c, 'Sketches', 'Same as task')).toBeVisible());
    expect(calls('set_subtask_tags')[0]).toEqual({ taskId: 't-logo', subtaskId: 'st-sketches', tags: null, expected: { tags: ['tag-revision'] } });
    // The reset is an entry of its own, so it reaches the other computers.
    expect(storedOf()?.tags).toBeNull();
  });

  it('asks for nothing when "Same as task" is pressed while the item already follows the task', async () => {
    const user = userEvent.setup();
    boot(world());
    const c = await card('Logo concepts');
    await user.click(tagsButton(c, 'Sketches', 'Same as task'));
    await user.click(dialogOf(c, 'Sketches').getByRole('button', { name: 'Same as task' }));
    expect(calls('set_subtask_tags')).toEqual([]);
  });

  it('closes when a press lands anywhere else, and the list of another item opens on its own', async () => {
    const user = userEvent.setup();
    boot(world());
    const c = await card('Logo concepts');
    await user.click(tagsButton(c, 'Sketches', 'Same as task'));
    expect(c.getByRole('dialog', { name: 'Tags for Sketches' })).toBeVisible();
    await user.click(tagsButton(c, 'Moodboard', 'Same as task'));
    expect(c.queryByRole('dialog', { name: 'Tags for Sketches' })).toBeNull();
    expect(c.getByRole('dialog', { name: 'Tags for Moodboard' })).toBeVisible();
    await user.click(document.body);
    expect(c.queryByRole('dialog')).toBeNull();
    // The same button opens it and closes it.
    await user.click(tagsButton(c, 'Moodboard', 'Same as task'));
    await user.click(tagsButton(c, 'Moodboard', 'Same as task'));
    expect(c.queryByRole('dialog')).toBeNull();
    expect(calls('set_subtask_tags')).toEqual([]);
  });
});

describe('choosing with the keyboard', () => {
  it('opens with Enter, moves with the arrow keys, ticks with Space and with Enter, and Escape closes and gives focus back', async () => {
    const user = userEvent.setup();
    boot(world());
    const c = await card('Logo concepts');
    const button = tagsButton(c, 'Sketches', 'Same as task');
    // A plain button, so Tab reaches it; here it is given focus directly, as the tab order of a whole page is not the point.
    button.focus();
    await user.keyboard('{Enter}');
    const list = dialogOf(c, 'Sketches');
    // Focus goes into the list, to its first control.
    expect(list.getByRole('button', { name: 'Same as task' })).toHaveFocus();
    await user.keyboard('{ArrowDown}');
    expect(list.getByRole('button', { name: 'Deselect all' })).toHaveFocus();
    await user.keyboard('{ArrowDown}');
    expect(list.getByRole('checkbox', { name: 'Concept' })).toHaveFocus();
    await user.keyboard(' ');
    await waitFor(() => expect(storedOf()?.tags).toEqual(['tag-revision', 'tag-admin']));
    // Focus stays where it was while the change is saved and drawn.
    expect(list.getByRole('checkbox', { name: 'Concept' })).toHaveFocus();
    await user.keyboard('{ArrowDown}{Enter}');
    await waitFor(() => expect(storedOf()?.tags).toEqual(['tag-admin']));
    expect(list.getByRole('checkbox', { name: 'Revision' })).toHaveFocus();
    expect(list.getByRole('checkbox', { name: 'Revision' })).not.toBeChecked();
    // End and Home go to the ends, and the arrows wrap.
    await user.keyboard('{End}');
    expect(list.getByRole('checkbox', { name: 'Admin' })).toHaveFocus();
    await user.keyboard('{ArrowDown}');
    expect(list.getByRole('button', { name: 'Same as task' })).toHaveFocus();
    await user.keyboard('{ArrowUp}');
    expect(list.getByRole('checkbox', { name: 'Admin' })).toHaveFocus();
    await user.keyboard('{Home}');
    expect(list.getByRole('button', { name: 'Same as task' })).toHaveFocus();
    await user.keyboard('{Escape}');
    expect(c.queryByRole('dialog')).toBeNull();
    expect(tagsButton(c, 'Sketches', 'Admin')).toHaveFocus();
    expect(calls('set_subtask_tags').map((a) => a.tags)).toEqual([['tag-revision', 'tag-admin'], ['tag-admin']]);
  });

  it('presses the buttons of the list with Enter and with Space, Same as task included', async () => {
    const user = userEvent.setup();
    boot(world());
    const c = await card('Logo concepts');
    tagsButton(c, 'Moodboard', 'Same as task').focus();
    await user.keyboard(' ');
    const list = dialogOf(c, 'Moodboard');
    expect(list.getByRole('button', { name: 'Same as task' })).toHaveFocus();
    // Enter on "Deselect all": No tag. The same button now says "Select all", and Enter on it ticks every tag.
    await user.keyboard('{ArrowDown}{Enter}');
    await waitFor(() => expect(storedOf('st-moodboard')?.tags).toEqual([]));
    expect(list.getByRole('button', { name: 'Select all' })).toHaveFocus();
    await user.keyboard('{Enter}');
    await waitFor(() => expect(storedOf('st-moodboard')?.tags).toEqual(['tag-concept', 'tag-revision', 'tag-admin']));
    // Enter on "Same as task" puts the item back: an entry that says so, so that the reset reaches the other computers.
    await user.keyboard('{Home}{Enter}');
    await waitFor(() => expect(storedOf('st-moodboard')?.tags).toBeNull());
    expect(list.getByRole('button', { name: 'Same as task' })).toHaveAttribute('aria-pressed', 'true');
    // Space does the same on each.
    await user.keyboard('{ArrowDown} ');
    await waitFor(() => expect(storedOf('st-moodboard')?.tags).toEqual([]));
    await user.keyboard('{Home} ');
    await waitFor(() => expect(storedOf('st-moodboard')?.tags).toBeNull());
    await user.keyboard('{Escape}');
    expect(tagsButton(c, 'Moodboard', 'Same as task')).toHaveFocus();
    expect(calls('set_subtask_tags').map((a) => a.tags)).toEqual([[], ['tag-concept', 'tag-revision', 'tag-admin'], null, [], null]);
  });

  it('closes when focus moves on past the list, without taking focus back', async () => {
    const user = userEvent.setup();
    boot(world());
    const c = await card('Logo concepts');
    await user.click(tagsButton(c, 'Sketches', 'Same as task'));
    const outside = c.getByRole('button', { name: 'Edit Logo concepts' });
    outside.focus();
    await waitFor(() => expect(c.queryByRole('dialog')).toBeNull());
    expect(outside).toHaveFocus();
  });
});

describe('while another computer holds the lease', () => {
  it('the button is off, with the reason, and opens nothing', async () => {
    const user = userEvent.setup();
    const s = world();
    seedLease(s, 'live');
    boot(s);
    const c = await card('Logo concepts');
    const button = tagsButton(c, 'Sketches', 'Same as task');
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute('title', readOnlyMessage('LAPTOP'));
    await user.click(button);
    expect(c.queryByRole('dialog')).toBeNull();
    expect(calls('set_subtask_tags')).toEqual([]);
  });

  it('an open list closes when the lease is taken, and no change is sent', async () => {
    const user = userEvent.setup();
    boot(world());
    const c = await card('Logo concepts');
    await user.click(tagsButton(c, 'Sketches', 'Same as task'));
    expect(c.getByRole('dialog', { name: 'Tags for Sketches' })).toBeVisible();
    await act(async () => {
      seedLease(state, 'live');
      await emit('state-changed');
    });
    await waitFor(() => expect(c.queryByRole('dialog')).toBeNull());
    expect(tagsButton(c, 'Sketches', 'Same as task')).toBeDisabled();
    expect(calls('set_subtask_tags')).toEqual([]);
  });

  it('a change that was already on its way when the lease went says what the backend said, and shows what is stored', async () => {
    const user = userEvent.setup();
    boot(world());
    const c = await card('Logo concepts');
    await user.click(tagsButton(c, 'Sketches', 'Same as task'));
    const box = dialogOf(c, 'Sketches').getByRole('checkbox', { name: 'Admin' });
    // The lease changes in the store with the page not yet told, so the click still goes out and is refused.
    seedLease(state, 'live');
    await user.click(box);
    await waitFor(() => expect(screen.getByText(readOnlyMessage('LAPTOP'))).toBeVisible());
    expect(storedOf()).toBeUndefined();
    await act(async () => {
      await emit('state-changed');
    });
    await waitFor(() => expect(tagsButton(c, 'Sketches', 'Same as task')).toBeVisible());
  });
});

describe('when the stored tags moved on since the row showed them', () => {
  it('writes nothing, says so, and shows what is stored now', async () => {
    const user = userEvent.setup();
    boot(world());
    const c = await card('Logo concepts');
    await user.click(tagsButton(c, 'Sketches', 'Same as task'));
    // Another computer gave the item a list while this one still shows "Same as task".
    const logo = state.tasks.find((t) => t.id === 't-logo');
    if (logo) logo.subtaskTags = { 'st-sketches': { tags: ['tag-concept'], stamp: SAME_STAMP } };
    await user.click(dialogOf(c, 'Sketches').getByRole('checkbox', { name: 'Revision' }));
    await waitFor(() => expect(c.getByRole('alert')).toHaveTextContent(CONFLICT_NOTE));
    expect(calls('set_subtask_tags')[0]).toMatchObject({ tags: ['tag-concept', 'tag-admin'], expected: { tags: null } });
    expect(storedOf()?.tags).toEqual(['tag-concept']);
    await waitFor(() => expect(tagsButton(c, 'Sketches', 'Concept')).toBeVisible());
    expect(dialogOf(c, 'Sketches').getByRole('checkbox', { name: 'Admin' })).not.toBeChecked();
    expect(dialogOf(c, 'Sketches').getByRole('checkbox', { name: 'Concept' })).toBeChecked();
    // The next choice starts from what is stored, and clears the note.
    await user.click(dialogOf(c, 'Sketches').getByRole('checkbox', { name: 'Admin' }));
    await waitFor(() => expect(storedOf()?.tags).toEqual(['tag-concept', 'tag-admin']));
    expect(c.queryByRole('alert')).toBeNull();
    expect(calls('set_subtask_tags')[1]).toMatchObject({ expected: { tags: ['tag-concept'] } });
  });

  it('says so too when the task lost a tag meanwhile and the list still offered it', async () => {
    const user = userEvent.setup();
    boot(world());
    const c = await card('Logo concepts');
    await user.click(tagsButton(c, 'Sketches', 'Same as task'));
    // The task's tags changed under the open list: it still offers Admin.
    const logo = state.tasks.find((t) => t.id === 't-logo');
    if (logo) logo.tags = ['tag-concept', 'tag-revision'];
    await user.click(dialogOf(c, 'Sketches').getByRole('checkbox', { name: 'Revision' }));
    // The list asks for Concept and Admin, and Admin is not the task's any more: a stale view of the task, so nothing is written.
    await waitFor(() => expect(c.getByRole('alert')).toHaveTextContent(CONFLICT_NOTE));
    expect(calls('set_subtask_tags')[0]).toMatchObject({ tags: ['tag-concept', 'tag-admin'], expected: { tags: null } });
    expect(storedOf()).toBeUndefined();
    // What it offers now is what the task has.
    await waitFor(() => expect(dialogOf(c, 'Sketches').queryByRole('checkbox', { name: 'Admin' })).toBeNull());
    expect(dialogOf(c, 'Sketches').getAllByRole('checkbox').map((e) => (e as HTMLInputElement).checked)).toEqual([true, true]);
  });
});

describe('changes that follow each other', () => {
  it('go out one at a time, the second from what the first asked for, with the row showing the latest meanwhile', async () => {
    boot(world());
    const c = await card('Logo concepts');
    const original = api.setSubtaskTags.bind(api);
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const spy = vi.spyOn(api, 'setSubtaskTags');
    spy.mockImplementationOnce(async (...args): Promise<SubtaskTagsReply> => {
      await gate;
      return original(...args);
    });
    fireEvent.click(tagsButton(c, 'Sketches', 'Same as task'));
    const list = dialogOf(c, 'Sketches');
    fireEvent.click(list.getByRole('checkbox', { name: 'Concept' }));
    fireEvent.click(list.getByRole('checkbox', { name: 'Revision' }));
    // Both are drawn at once, though neither has been saved, and only the first has been sent.
    expect(list.getByRole('checkbox', { name: 'Concept' })).not.toBeChecked();
    expect(list.getByRole('checkbox', { name: 'Revision' })).not.toBeChecked();
    expect(list.getByRole('checkbox', { name: 'Admin' })).toBeChecked();
    await act(async () => undefined);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(storedOf()).toBeUndefined();
    await act(async () => {
      release();
      await gate;
    });
    await waitFor(() => expect(storedOf()?.tags).toEqual(['tag-admin']));
    expect(spy.mock.calls.map(([, , tags, expected]) => [tags, expected])).toEqual([
      [['tag-revision', 'tag-admin'], { tags: null }],
      [['tag-admin'], { tags: ['tag-revision', 'tag-admin'] }],
    ]);
    await waitFor(() => expect(tagsButton(c, 'Sketches', 'Admin')).toBeVisible());
    expect(c.queryByRole('alert')).toBeNull();
  });

  it('shows an error when a save fails, and the row goes back to what is stored', async () => {
    const user = userEvent.setup();
    const s = world();
    boot(s);
    const c = await card('Logo concepts');
    await user.click(tagsButton(c, 'Sketches', 'Same as task'));
    s.failNext = ['set_subtask_tags'];
    await user.click(dialogOf(c, 'Sketches').getByRole('checkbox', { name: 'Concept' }));
    await waitFor(() => expect(screen.getByText('mock: set_subtask_tags failed')).toBeVisible());
    await waitFor(() => expect(dialogOf(c, 'Sketches').getByRole('checkbox', { name: 'Concept' })).toBeChecked());
    expect(tagsButton(c, 'Sketches', 'Same as task')).toBeVisible();
    expect(storedOf()).toBeUndefined();
  });
});
