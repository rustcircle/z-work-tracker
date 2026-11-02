// The rule, through the real editor and the mock backend: an automatic save never silently overwrites text
// the user has not seen, and the user's own unsaved words never vanish silently. QC-n names the gate finding
// each case came from.
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { emit } from '@tauri-apps/api/event';
import { clearMocks } from '@tauri-apps/api/mocks';
import { act, cleanup, fireEvent, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { boot as bootApp, polyfillDom } from '../../components/testKit';
import { HOLD_READ_MS } from './TaskEditor';
import { api } from '../../lib/api';
import { demoState } from '../../mocks/demoSeed';
import type { MockState } from '../../mocks/ipcMock';

/** Longer than the five retries added up. */
const ALL_RETRIES_MS = 70_000;
const elsewhere = { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'From another device' }] }] };

type User = ReturnType<typeof userEvent.setup>;

let state: MockState;
let storeDown: boolean;
/** Runs just before the next save reaches the backend: something landing between the page's look and the write. */
let beforeWrite: (() => void) | null;

beforeEach(() => {
  polyfillDom();
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'], shouldAdvanceTime: true });
  storeDown = false;
  beforeWrite = null;
  const real = api.patchTask;
  vi.spyOn(api, 'patchTask').mockImplementation((...args) => {
    if (storeDown) return Promise.reject({ code: 'io', message: 'the data file is locked' });
    beforeWrite?.();
    beforeWrite = null;
    return real(...args);
  });
});

afterEach(async () => {
  cleanup();
  await act(() => vi.advanceTimersByTimeAsync(ALL_RETRIES_MS));
  clearMocks();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const guide = () => {
  const g = state.tasks.find((t) => t.id === 't-guide');
  if (!g) throw new Error('the demo has no Brand guidelines');
  return g;
};
const storedText = () => JSON.stringify(guide().description);
const pass = (ms: number) => act(() => vi.advanceTimersByTimeAsync(ms));
const form = () => screen.getByRole('form', { name: /^Editing / });
const editorOpen = () => screen.queryByRole('form', { name: /^Editing / }) !== null;
const box = () => within(form()).getByRole('textbox', { name: 'Description' });
const nameBox = () => within(form()).getByRole('textbox', { name: 'Task name' });
const saveState = () => within(form()).getByTestId('save-state');
const kind = () => saveState().getAttribute('data-kind');
const discardButton = () => within(form()).queryByRole('button', { name: 'Discard my words' });
const countOf = (cmd: string) => state.calls.filter((c) => c.cmd === cmd).length;
/** The fields the notice names, in the form's order. */
const heldNow = () => ['name', 'project', 'description', 'tags'].filter((f) => saveState().textContent?.split('Press Done')[0]?.includes(f));

/** Another device's text lands in the store, and this page hears of it. */
async function arrive(change: () => void = () => void (guide().description = elsewhere)) {
  change();
  state.revision += 1;
  await act(() => emit('state-changed'));
  await pass(100);
}

async function openEditor(): Promise<User> {
  const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime.bind(vi) });
  state = demoState();
  bootApp(state);
  await user.click(await screen.findByRole('button', { name: 'Edit Brand guidelines' }));
  return user;
}
const toggle = (u: User) => u.click(screen.getByRole('button', { name: /^Edit Brand guidelines/ }));
const done = (u: User) => u.click(screen.getByRole('button', { name: 'Done' }));

/** The next save waits at the backend's door until the returned function is called. */
function gateNextSave(): () => void {
  const impl = vi.mocked(api.patchTask).getMockImplementation();
  if (!impl) throw new Error('patchTask is not spied on');
  let land: () => void = () => undefined;
  vi.mocked(api.patchTask).mockImplementationOnce(
    (...args) =>
      new Promise((resolve, reject) => {
        land = () => void impl(...args).then(resolve, reject);
      }),
  );
  return () => land();
}

/** Words typed, newer text in, and the autosave has met it: the notice is on screen, and has been long enough to read. */
async function holdWords(): Promise<User> {
  const user = await openEditor();
  await user.click(box());
  await user.keyboard(' mine');
  await arrive();
  await pass(1000);
  expect(kind()).toBe('conflict');
  await pass(HOLD_READ_MS);
  return user;
}

describe('newer text and a holding save', () => {
  it('retries used up, newer text, reopened: nothing sent, and it says so', async () => {
    const user = await openEditor();
    await user.click(box());
    await user.keyboard(' mine');
    storeDown = true;
    await toggle(user);
    await pass(ALL_RETRIES_MS);
    await arrive();
    storeDown = false;
    await toggle(user);
    await pass(ALL_RETRIES_MS);
    expect(storedText()).toContain('From another');
    expect(storedText()).not.toContain('mine');
    expect(kind()).toBe('conflict');
  });

  it('inside the backoff, newer text, reopened: the same', async () => {
    const user = await openEditor();
    await user.click(box());
    await user.keyboard(' mine');
    storeDown = true;
    await toggle(user);
    await pass(100);
    await arrive();
    storeDown = false;
    await toggle(user);
    await pass(ALL_RETRIES_MS);
    expect(storedText()).toContain('From another');
    expect(storedText()).not.toContain('mine');
    expect(kind()).toBe('conflict');
  });

  it('the first save, on closing with the card button: held, with a banner', async () => {
    const user = await openEditor();
    await user.click(box());
    await user.keyboard(' mine');
    await arrive();
    await toggle(user);
    await pass(ALL_RETRIES_MS);
    expect(storedText()).toContain('From another');
    expect(storedText()).not.toContain('mine');
    expect(screen.getByRole('alert')).toHaveTextContent('changed elsewhere');
  });

  it('an open editor whose save failed: its retry holds', async () => {
    const user = await openEditor();
    await user.click(box());
    await user.keyboard(' mine');
    storeDown = true;
    await pass(1000);
    await arrive();
    storeDown = false;
    await pass(ALL_RETRIES_MS);
    expect(storedText()).toContain('From another');
    expect(storedText()).not.toContain('mine');
    expect(kind()).toBe('conflict');
  });

  it('a sync landing between the look and the write is refused too', async () => {
    const user = await openEditor();
    await user.click(box());
    await user.keyboard(' mine');
    beforeWrite = () => {
      guide().description = elsewhere;
    };
    await pass(2000);
    expect(storedText()).toContain('From another');
    expect(storedText()).not.toContain('mine');
    expect(kind()).toBe('conflict');
    expect(box()).toHaveTextContent('mine');
  });
});

describe('QC-1: an editor with nothing unsaved', () => {
  it('never typed in: shows the newer text, and typing goes on from it', async () => {
    const user = await openEditor();
    await user.click(box());
    await arrive();
    expect(box()).toHaveTextContent('From another device');
    await user.keyboard(' x');
    await pass(2000);
    expect(storedText()).toContain('From another');
    expect(storedText()).toContain(' x');
    expect(kind()).toBe('saved');
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('typed, saved, paused: the same', async () => {
    const user = await openEditor();
    await user.click(box());
    await user.keyboard(' first');
    await pass(2000);
    expect(kind()).toBe('saved');
    await arrive();
    expect(box()).toHaveTextContent('From another device');
    expect(box()).not.toHaveTextContent('first');
    await user.keyboard(' second');
    await pass(2000);
    expect(storedText()).toContain('From another');
    expect(storedText()).toContain(' second');
  });

  it('a name renamed elsewhere shows, and typing goes on from it', async () => {
    const user = await openEditor();
    await arrive(() => {
      guide().name = 'Renamed elsewhere';
    });
    expect(nameBox()).toHaveValue('Renamed elsewhere');
    await user.type(nameBox(), ' v2');
    await pass(2000);
    expect(guide().name).toBe('Renamed elsewhere v2');
    expect(kind()).toBe('saved');
  });

  it('a project and tags changed elsewhere show as well', async () => {
    await openEditor();
    await arrive(() => {
      guide().projectId = 'p-pack';
      guide().tags = ['tag-admin'];
    });
    expect(within(form()).getByRole('combobox', { name: 'Project' })).toHaveValue('p-pack');
    expect(within(form()).getByRole('checkbox', { name: /Admin/ })).toBeChecked();
    expect(kind()).not.toBe('conflict');
  });

  it('mid-composition the shown text is left alone, and the composed words hold', async () => {
    const user = await openEditor();
    await user.click(box());
    await act(async () => {
      box().dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
    });
    await arrive();
    expect(box()).not.toHaveTextContent('From another device');
    await act(async () => {
      box().dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: '' }));
    });
    await pass(100);
    await user.keyboard(' composed');
    await pass(2000);
    expect(storedText()).toContain('From another');
    expect(storedText()).not.toContain('composed');
    expect(kind()).toBe('conflict');
    expect(box()).toHaveTextContent('composed');
  });
});

describe('QC-2: Done', () => {
  it('whose blur meets newer text keeps the editor open with the notice', async () => {
    const user = await openEditor();
    await user.click(box());
    await user.keyboard(' mine');
    await arrive();
    await done(user);
    await pass(2000);
    expect(storedText()).toContain('From another');
    expect(storedText()).not.toContain('mine');
    expect(editorOpen()).toBe(true);
    expect(kind()).toBe('conflict');
  });

  it('the same when the reply comes after the press has ended', async () => {
    const user = await openEditor();
    await user.click(box());
    await user.keyboard(' mine');
    await arrive();
    const impl = vi.mocked(api.patchTask).getMockImplementation();
    const snapshotImpl = api.getSnapshot;
    if (!impl) throw new Error('patchTask is not spied on');
    let land: () => void = () => undefined;
    // Whichever the save asks first waits until the click is over.
    const gate = new Promise<void>((resolve) => {
      land = resolve;
    });
    vi.mocked(api.patchTask).mockImplementationOnce((...args) => gate.then(() => impl(...args)));
    vi.spyOn(api, 'getSnapshot').mockImplementationOnce(() => gate.then(() => snapshotImpl()));
    await done(user);
    await act(async () => land());
    await pass(2000);
    expect(storedText()).toContain('From another');
    expect(storedText()).not.toContain('mine');
    expect(editorOpen()).toBe(true);
    expect(kind()).toBe('conflict');
  });

  it('after the notice is the choice to save over the newer text, and closes', async () => {
    const user = await holdWords();
    await done(user);
    await pass(2000);
    expect(storedText()).not.toContain('From another');
    expect(storedText()).toContain('mine');
    expect(editorOpen()).toBe(false);
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('overrides only what was held before the press, not what its own blur just held', async () => {
    const user = await openEditor();
    await user.type(nameBox(), ' v2');
    await arrive(() => {
      guide().name = 'Renamed elsewhere';
    });
    await pass(1000);
    expect(kind()).toBe('conflict');
    await pass(HOLD_READ_MS);
    await user.click(box());
    await user.keyboard(' mine');
    await arrive();
    await done(user);
    await pass(2000);
    // The name was on screen as held: Done is the choice. The words only met newer text during this press.
    expect(guide().name).toBe('Brand guidelines v2');
    expect(storedText()).toContain('From another');
    expect(storedText()).not.toContain('mine');
    expect(editorOpen()).toBe(true);
    expect(kind()).toBe('conflict');
    expect(saveState()).toHaveTextContent('description');
    expect(saveState()).not.toHaveTextContent('name');
  });

  it('the override carries no expected value, and one that fails goes back to being held', async () => {
    const user = await holdWords();
    storeDown = true;
    await done(user);
    await pass(100);
    expect(editorOpen()).toBe(true);
    expect(saveState()).toHaveTextContent('changed elsewhere');
    expect(discardButton()).not.toBeNull();
    // No automatic retry may send it: newer text could have come by then.
    storeDown = false;
    await arrive(() => {
      guide().description = { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Newer still' }] }] };
    });
    await pass(ALL_RETRIES_MS);
    expect(storedText()).toContain('Newer still');
    await done(user);
    await pass(2000);
    expect(storedText()).toContain('mine');
    const last = state.calls.filter((c) => c.cmd === 'patch_task').at(-1)?.args as { expected?: Record<string, unknown> } | undefined;
    expect(last?.expected?.description).toBeUndefined();
    expect(editorOpen()).toBe(false);
  });
});

describe('QC-3: typing on a held value', () => {
  it('keeps the hold and the newer text, however long it goes on', async () => {
    const user = await holdWords();
    await user.keyboard(' more');
    await pass(50);
    expect(kind()).toBe('conflict');
    await pass(2000);
    await user.keyboard(' and more');
    await pass(ALL_RETRIES_MS);
    expect(storedText()).toContain('From another');
    expect(storedText()).not.toContain('mine');
    expect(kind()).toBe('conflict');
    expect(box()).toHaveTextContent('and more');
  });

  it('does not stop other fields from saving', async () => {
    const user = await holdWords();
    await user.type(nameBox(), ' v2');
    await pass(2000);
    expect(guide().name).toBe('Brand guidelines v2');
    expect(storedText()).toContain('From another');
    expect(kind()).toBe('conflict');
    expect(discardButton()).not.toBeNull();
  });
});

describe('QC-4: a closed editor whose retry holds', () => {
  async function closedWithAHold() {
    const user = await openEditor();
    storeDown = true;
    await user.type(nameBox(), ' v2');
    await user.click(box());
    await user.keyboard(' mine');
    await user.click(screen.getByRole('button', { name: /^Edit Brand guidelines/ }));
    await pass(100);
    await arrive();
    storeDown = false;
    await pass(ALL_RETRIES_MS);
    return user;
  }

  it('sends the rest, keeps the words, and the banner stays up after that save', async () => {
    await closedWithAHold();
    expect(guide().name).toBe('Brand guidelines v2');
    expect(storedText()).toContain('From another');
    expect(storedText()).not.toContain('mine');
    expect(editorOpen()).toBe(false);
    expect(screen.getByRole('alert')).toHaveTextContent('changed elsewhere');
  });

  it('the banner outlives other successful actions, and goes when the editor shows the notice', async () => {
    const user = await closedWithAHold();
    await user.click(screen.getByRole('button', { name: 'Hide earnings' }));
    await pass(100);
    expect(screen.getByRole('alert')).toHaveTextContent('changed elsewhere');
    await user.click(screen.getByRole('button', { name: 'Edit Brand guidelines v2' }));
    expect(screen.queryByRole('alert')).toBeNull();
    expect(kind()).toBe('conflict');
    expect(box()).toHaveTextContent('mine');
  });

  it('the banner comes back on closing again with the words still held, and leaves after Discard', async () => {
    const user = await closedWithAHold();
    await user.click(screen.getByRole('button', { name: 'Edit Brand guidelines v2' }));
    await user.click(screen.getByRole('button', { name: 'Edit Brand guidelines v2' }));
    await pass(100);
    expect(screen.getByRole('alert')).toHaveTextContent('changed elsewhere');
    await user.click(screen.getByRole('button', { name: 'Edit Brand guidelines v2' }));
    await user.click(screen.getByRole('button', { name: 'Discard my words' }));
    await user.click(screen.getByRole('button', { name: 'Edit Brand guidelines v2' }));
    await pass(100);
    expect(screen.queryByRole('alert')).toBeNull();
  });
});

describe('QC-C: a closed editor whose saves failed until the retries ran out', () => {
  const unsent = () => screen.queryAllByTestId('unsent-banner');
  const tries = () => vi.mocked(api.patchTask).mock.calls.length;
  const hideEarnings = (u: User) => u.click(screen.getByRole('button', { name: 'Hide earnings' }));

  async function closedOnFailures(typed: (u: User) => Promise<unknown> = async (u) => {
    await u.click(box());
    await u.keyboard(' mine');
  }): Promise<User> {
    const user = await openEditor();
    await typed(user);
    storeDown = true;
    await toggle(user);
    await pass(ALL_RETRIES_MS);
    expect(editorOpen()).toBe(false);
    return user;
  }

  it('says in a banner of its own that an edit is waiting, and what closing the app would do', async () => {
    await closedOnFailures();
    expect(storedText()).not.toContain('mine');
    expect(unsent()).toHaveLength(1);
    expect(unsent()[0]).toHaveTextContent('Your edit to the description of “Brand guidelines” could not be saved yet');
    expect(unsent()[0]).toHaveTextContent('your words come back at the next launch');
  });

  it('a name or project says it would be lost', async () => {
    await closedOnFailures((u) => u.type(nameBox(), ' v2'));
    expect(unsent()[0]).toHaveTextContent('Your edit to the name of “Brand guidelines”');
    expect(unsent()[0]).toHaveTextContent('If the app closes first, your edit is lost');
  });

  it('a later success sends the words, and only that ends the banner', async () => {
    const user = await closedOnFailures();
    storeDown = false;
    await hideEarnings(user);
    await pass(100);
    expect(storedText()).toContain('mine');
    expect(unsent()).toHaveLength(0);
    expect(screen.queryByRole('alert')).toBeNull();
    expect(state.drafts['t-guide']).toBeUndefined();
  });

  it('a later success whose retry still fails leaves the banner up, and tries once more', async () => {
    const user = await closedOnFailures();
    const before = tries();
    await hideEarnings(user);
    await pass(100);
    expect(tries()).toBe(before + 1);
    expect(storedText()).not.toContain('mine');
    expect(unsent()).toHaveLength(1);
    // Nothing goes round in circles: the next try waits for the next success.
    await pass(ALL_RETRIES_MS);
    expect(tries()).toBe(before + 1);
  });

  it('dismissing the error leaves the banner', async () => {
    const user = await closedOnFailures();
    await user.click(screen.getByRole('button', { name: 'Dismiss error' }));
    expect(unsent()).toHaveLength(1);
  });

  it('newer text meanwhile: the retry after a later success holds, and the held banner takes over', async () => {
    const user = await closedOnFailures();
    storeDown = false;
    guide().description = elsewhere;
    await hideEarnings(user);
    await pass(100);
    expect(storedText()).toContain('From another');
    expect(storedText()).not.toContain('mine');
    expect(unsent()).toHaveLength(0);
    expect(screen.getByTestId('held-banner')).toHaveTextContent('changed elsewhere');
  });

  it('reopening shows the words in the editor and takes over from the banner', async () => {
    const user = await closedOnFailures();
    await toggle(user);
    expect(unsent()).toHaveLength(0);
    expect(box()).toHaveTextContent('mine');
    await toggle(user);
    await pass(100);
    expect(unsent()).toHaveLength(1);
  });

  it('says nothing while saves work, or for an editor on screen', async () => {
    const user = await openEditor();
    await user.click(box());
    await user.keyboard(' mine');
    storeDown = true;
    await pass(ALL_RETRIES_MS);
    expect(kind()).toBe('failed');
    expect(unsent()).toHaveLength(0);
    storeDown = false;
    await done(user);
    await pass(2000);
    expect(editorOpen()).toBe(false);
    expect(unsent()).toHaveLength(0);
    expect(storedText()).toContain('mine');
  });

  it('a stash that failed with the save is written again, for the app closing first', async () => {
    const user = await openEditor();
    await user.click(box());
    storeDown = true;
    vi.spyOn(api, 'stashDraft').mockRejectedValueOnce({ code: 'io', message: 'the data file is locked' });
    await user.keyboard(' mine');
    await toggle(user);
    await pass(ALL_RETRIES_MS);
    expect(JSON.stringify(state.drafts['t-guide'])).toContain('mine');
  });
});

describe('an edit to a task deleted elsewhere', () => {
  const noticesShown = () => screen.queryAllByTestId('notice').map((n) => n.textContent ?? '');
  async function deleteIt() {
    state.tasks = state.tasks.filter((t) => t.id !== 't-guide');
    state.revision += 1;
    await act(() => emit('state-changed'));
    await pass(5000);
  }

  it('typed words go in a notice that says why, and nothing else is left up', async () => {
    const user = await openEditor();
    await user.click(box());
    await user.keyboard(' mine');
    await deleteIt();
    expect(editorOpen()).toBe(false);
    const shown = noticesShown();
    expect(shown).toHaveLength(1);
    expect(shown[0]).toContain('mine');
    expect(shown[0]).toContain('“Brand guidelines”');
    expect(shown[0]).toContain('no longer exists');
    expect(screen.queryByRole('alert')).toBeNull();
    expect(state.drafts['t-guide']).toBeUndefined();
  });

  it('so do held words, which had no save left to find out', async () => {
    await holdWords();
    await deleteIt();
    const shown = noticesShown();
    expect(shown).toHaveLength(1);
    expect(shown[0]).toContain('mine');
    expect(screen.queryByRole('alert')).toBeNull();
    expect(state.drafts['t-guide']).toBeUndefined();
  });

  it('so does a new name', async () => {
    const user = await openEditor();
    await user.type(nameBox(), ' v2');
    await deleteIt();
    const shown = noticesShown();
    expect(shown).toHaveLength(1);
    expect(shown[0]).toContain('Brand guidelines v2');
  });

  it('so do words of a closed editor whose retries ran out, with no save under way', async () => {
    const user = await openEditor();
    await user.click(box());
    await user.keyboard(' mine');
    storeDown = true;
    await toggle(user);
    await pass(ALL_RETRIES_MS);
    const tries = countOf('patch_task');
    await deleteIt();
    expect(noticesShown()[0]).toContain('mine');
    expect(countOf('patch_task')).toBe(tries);
  });

  it('so do words of a save that finds out first, as the page has not heard yet', async () => {
    const user = await openEditor();
    await user.click(box());
    await user.keyboard(' mine');
    state.tasks = state.tasks.filter((t) => t.id !== 't-guide');
    await pass(2000);
    expect(noticesShown()[0]).toContain('mine');
    expect(editorOpen()).toBe(false);
    expect(screen.queryByRole('alert')).toBeNull();
    expect(state.drafts['t-guide']).toBeUndefined();
  });

  it('says nothing for an editor with nothing unsaved', async () => {
    const user = await openEditor();
    await user.click(box());
    await user.keyboard(' mine');
    await pass(2000);
    expect(kind()).toBe('saved');
    await deleteIt();
    expect(noticesShown()).toEqual([]);
    expect(screen.queryByRole('alert')).toBeNull();
  });
});

describe('found in review of the fixes', () => {
  const noticesShown = () => screen.queryAllByTestId('notice').map((n) => n.textContent ?? '');
  const unsent = () => screen.queryAllByTestId('unsent-banner');
  const tries = () => vi.mocked(api.patchTask).mock.calls.length;

  it('a stash that failed is written again when the save is refused, as the notice promises the words come back', async () => {
    const user = await openEditor();
    await user.click(box());
    vi.spyOn(api, 'stashDraft').mockRejectedValueOnce({ code: 'io', message: 'the drafts file is locked' });
    await user.keyboard(' mine');
    await pass(400);
    expect(state.drafts['t-guide']).toBeUndefined();
    await arrive();
    await pass(1000);
    expect(kind()).toBe('conflict');
    expect(saveState()).toHaveTextContent('they come back as a notice at the next launch');
    expect(JSON.stringify(state.drafts['t-guide'])).toContain('mine');
  });

  it('stashes that keep failing get another try from whatever goes through a save next, as held words count on them', async () => {
    const user = await openEditor();
    await user.click(box());
    const stash = vi.spyOn(api, 'stashDraft');
    stash.mockRejectedValueOnce({ code: 'io', message: 'the drafts file is locked' });
    stash.mockRejectedValueOnce({ code: 'io', message: 'the drafts file is locked' });
    await user.keyboard(' mine');
    await pass(400);
    await arrive();
    await pass(1000);
    expect(kind()).toBe('conflict');
    expect(stash).toHaveBeenCalledTimes(2);
    expect(state.drafts['t-guide']).toBeUndefined();
    await toggle(user);
    await pass(100);
    expect(JSON.stringify(state.drafts['t-guide'] ?? null)).toContain('mine');
  });

  it('a key typed while a save finds the task gone leaves no stash, so dismissed words stay dismissed', async () => {
    const user = await openEditor();
    await user.click(box());
    await user.keyboard(' one');
    const land = gateNextSave();
    await pass(700);
    await user.keyboard(' two');
    state.tasks = state.tasks.filter((t) => t.id !== 't-guide');
    await act(async () => land());
    await pass(2000);
    expect(noticesShown()[0]).toContain('one two');
    expect(state.drafts['t-guide']).toBeUndefined();
  });

  it('an edit that can never pass says why, and later writes neither try it again nor bring the error back', async () => {
    const user = await openEditor();
    await user.type(nameBox(), 'x'.repeat(250));
    await toggle(user);
    await pass(100);
    expect(editorOpen()).toBe(false);
    const sent = tries();
    await pass(ALL_RETRIES_MS);
    expect(tries()).toBe(sent);
    const banner = unsent()[0];
    expect(banner).toHaveTextContent("can't be saved: Task name is longer than 200 characters");
    expect(banner).toHaveTextContent("Open the task's editor to change it");
    expect(banner).not.toHaveTextContent('sent again');
    await user.click(screen.getByRole('button', { name: 'Hide earnings' }));
    await pass(100);
    expect(tries()).toBe(sent);
    expect(screen.getAllByRole('alert')).toHaveLength(1);
    expect(unsent()).toHaveLength(1);
    // The fix is the user's, in the editor, and then it goes.
    await user.click(screen.getByRole('button', { name: /^Edit Brand guidelines/ }));
    await user.clear(nameBox());
    await user.type(nameBox(), 'Brand guidelines v2');
    await pass(2000);
    expect(guide().name).toBe('Brand guidelines v2');
    await done(user);
    await pass(100);
    expect(unsent()).toHaveLength(0);
  });

  it('a refusal after the retries ran out stops later writes from trying that edit', async () => {
    const user = await openEditor();
    await user.click(box());
    await user.keyboard(' mine');
    storeDown = true;
    await toggle(user);
    await pass(ALL_RETRIES_MS);
    storeDown = false;
    vi.mocked(api.patchTask).mockRejectedValueOnce({ code: 'validation', message: 'A description can be this long at most' });
    const hideEarnings = () => user.click(screen.getByRole('button', { name: 'Hide earnings' }));
    const before = tries();
    await hideEarnings();
    await pass(100);
    expect(tries()).toBe(before + 1);
    expect(unsent()[0]).toHaveTextContent("can't be saved: A description can be this long at most");
    await hideEarnings();
    await pass(100);
    expect(tries()).toBe(before + 1);
    expect(storedText()).not.toContain('mine');
  });

  it('a double click on Done whose first click brings the notice on chooses nothing with its second', async () => {
    const user = await openEditor();
    await user.click(box());
    await user.keyboard(' mine');
    await arrive();
    await user.dblClick(within(form()).getByRole('button', { name: 'Done' }));
    await pass(2000);
    expect(storedText()).toContain('From another');
    expect(storedText()).not.toContain('mine');
    expect(editorOpen()).toBe(true);
    expect(kind()).toBe('conflict');
  });
});

describe('QC-5: a save', () => {
  it('reads nothing back: no get_snapshot of its own', async () => {
    const user = await openEditor();
    await pass(100);
    const before = countOf('get_snapshot');
    await user.click(box());
    await user.keyboard(' words');
    await pass(2000);
    expect(storedText()).toContain('words');
    expect(countOf('patch_task')).toBe(1);
    expect(countOf('get_snapshot')).toBe(before);
  });
});

describe('QC-7: a held value and a failure of another field', () => {
  it('keeps the notice and Discard on screen beside the failure', async () => {
    const user = await holdWords();
    storeDown = true;
    await user.type(nameBox(), ' v2');
    await pass(ALL_RETRIES_MS);
    expect(saveState()).toHaveTextContent('Not saved');
    expect(saveState()).toHaveTextContent('changed elsewhere');
    expect(discardButton()).not.toBeNull();
    storeDown = false;
    await user.click(discardButton() as HTMLElement);
    expect(box()).toHaveTextContent('From another device');
  });
});

describe('never a false conflict', () => {
  const noConflict = () => {
    expect(kind()).toBe('saved');
    expect(screen.queryByRole('alert')).toBeNull();
    expect(discardButton()).toBeNull();
  };

  it('ordinary typing, in bursts, with a blur in the middle', async () => {
    const user = await openEditor();
    await user.click(box());
    for (let i = 0; i < 5; i++) {
      await user.keyboard(` w${i}`);
      await pass(620);
    }
    await user.tab();
    await pass(10);
    await user.click(box());
    await user.keyboard(' tail');
    await pass(10);
    await user.tab();
    await pass(1000);
    expect(storedText()).toContain('tail');
    noConflict();
  });

  it('two quick saves, the second sent while the first is still on its way', async () => {
    const user = await openEditor();
    await user.click(box());
    const impl = vi.mocked(api.patchTask).getMockImplementation();
    if (!impl) throw new Error('patchTask is not spied on');
    let land: () => void = () => undefined;
    vi.mocked(api.patchTask).mockImplementationOnce(
      (...args) =>
        new Promise((resolve, reject) => {
          land = () => void impl(...args).then(resolve, reject);
        }),
    );
    await user.keyboard(' first');
    await pass(700);
    await user.keyboard(' second');
    await pass(700);
    await act(async () => land());
    await pass(2000);
    expect(storedText()).toContain('first second');
    noConflict();
  });

  it('a stale snapshot reply landing after a save neither moves the editor back nor makes a conflict (QC-8)', async () => {
    const user = await openEditor();
    await user.click(box());
    const real = api.getSnapshot;
    const old = await real();
    let release: () => void = () => undefined;
    const late = new Promise<void>((resolve) => {
      release = resolve;
    });
    vi.spyOn(api, 'getSnapshot').mockImplementationOnce(() => late.then(() => old));
    await act(() => emit('state-changed'));
    await user.keyboard(' first');
    await pass(2000);
    expect(kind()).toBe('saved');
    await act(async () => release());
    await pass(50);
    expect(box()).toHaveTextContent('first');
    await user.keyboard(' second');
    await pass(2000);
    expect(storedText()).toContain('first second');
    noConflict();
  });

  it('a reply that went out before a newer one is not adopted, whatever comes first', async () => {
    const user = await openEditor();
    await pass(100);
    await user.type(nameBox(), ' v2');
    await pass(2000);
    const newest = await api.getSnapshot();
    await arrive(() => {
      guide().name = 'Renamed elsewhere';
    });
    expect(nameBox()).toHaveValue('Renamed elsewhere');
    // A reply built before that sync, arriving after it.
    vi.spyOn(api, 'getSnapshot').mockImplementationOnce(() => Promise.resolve(newest));
    await act(() => emit('state-changed'));
    await pass(100);
    expect(nameBox()).toHaveValue('Renamed elsewhere');
  });

  it('a save racing a sync of another field', async () => {
    const user = await openEditor();
    await user.click(box());
    await user.keyboard(' mine');
    beforeWrite = () => {
      guide().name = 'Renamed elsewhere';
    };
    await pass(2000);
    expect(storedText()).toContain('mine');
    expect(guide().name).toBe('Renamed elsewhere');
    expect(nameBox()).toHaveValue('Renamed elsewhere');
    noConflict();
  });

  it('a refresh that shows the save before its own reply is back', async () => {
    const user = await openEditor();
    await user.click(box());
    const impl = vi.mocked(api.patchTask).getMockImplementation();
    if (!impl) throw new Error('patchTask is not spied on');
    let reply: () => void = () => undefined;
    vi.mocked(api.patchTask).mockImplementationOnce(async (...args) => {
      const out = await impl(...args);
      await new Promise<void>((resolve) => {
        reply = resolve;
      });
      return out;
    });
    await user.keyboard(' mine');
    await pass(700);
    await act(() => emit('state-changed'));
    await pass(50);
    await act(async () => reply());
    await pass(2000);
    expect(storedText()).toContain('mine');
    expect(box()).toHaveTextContent('mine');
    noConflict();
  });

  it('the same text arriving from elsewhere is success, not a conflict', async () => {
    const user = await openEditor();
    await user.type(nameBox(), ' v2');
    beforeWrite = () => {
      guide().name = 'Brand guidelines v2';
    };
    await pass(2000);
    expect(guide().name).toBe('Brand guidelines v2');
    noConflict();
  });

  it('the running clock and a sync of another task change nothing', async () => {
    const user = await openEditor();
    await user.click(box());
    await user.keyboard(' mine');
    await arrive(() => {
      const other = state.tasks.find((t) => t.id !== 't-guide');
      if (other) other.name = 'Another task renamed';
    });
    await pass(2000);
    expect(storedText()).toContain('mine');
    noConflict();
  });
});

describe('never nameless or unassigned', () => {
  it('a blank name is not sent, whatever else is', async () => {
    const user = await openEditor();
    await user.clear(nameBox());
    await pass(2000);
    expect(guide().name).toBe('Brand guidelines');
    await user.click(box());
    await user.keyboard(' x');
    await pass(100);
    await toggle(user);
    await pass(ALL_RETRIES_MS);
    expect(guide().name).toBe('Brand guidelines');
    expect(state.projects.map((p) => p.id)).toContain(guide().projectId);
    await toggle(user);
    expect(nameBox()).toHaveValue('Brand guidelines');
  });

  it('a held name blanked and then Done keeps a name', async () => {
    const user = await openEditor();
    await user.type(nameBox(), ' v2');
    await arrive(() => {
      guide().name = 'Renamed elsewhere';
    });
    await pass(1000);
    expect(kind()).toBe('conflict');
    await user.clear(nameBox());
    await done(user);
    await pass(2000);
    expect(guide().name).toBe('Renamed elsewhere');
  });
});

describe('what the notices say', () => {
  it('says the newer text cannot be read first, and how to see both', async () => {
    const user = await holdWords();
    expect(saveState()).toHaveTextContent("Press Done to save them over the newer text, which you can't read first");
    expect(saveState()).toHaveTextContent('To see both, copy your words, press Discard my words, and paste them back');
    await user.type(nameBox(), ' v2');
    await arrive(() => {
      guide().name = 'Renamed elsewhere';
    });
    await pass(1000);
    expect(saveState()).toHaveTextContent("Press Done to save them over the newer ones, which you can't read first");
    expect(saveState()).toHaveTextContent('To see both, copy your words, press Discard my words, and paste them back');
  });

  it('the way it gives to see both works: the words paste back over the newer text and save', async () => {
    const user = await holdWords();
    await user.click(discardButton() as HTMLElement);
    expect(box()).toHaveTextContent('From another device');
    await user.click(box());
    await user.keyboard(' mine');
    await pass(2000);
    expect(kind()).toBe('saved');
    expect(storedText()).toContain('From another device');
    expect(storedText()).toContain(' mine');
  });

  it('held words are said to come back as a notice, and other fields to be lost, if the app closes first', async () => {
    const user = await holdWords();
    expect(saveState()).toHaveTextContent('If the app closes first, they come back as a notice at the next launch');
    await user.type(nameBox(), ' v2');
    await arrive(() => {
      guide().name = 'Renamed elsewhere';
    });
    await pass(1000);
    expect(saveState()).toHaveTextContent('The name and description changed elsewhere');
    expect(saveState()).toHaveTextContent('If the app closes first, the description comes back as a notice at the next launch and the rest is lost');
  });

  it('says typing changes nothing until Done', async () => {
    await holdWords();
    expect(saveState()).toHaveTextContent('Typing on does not send them');
  });
});

describe('a stash the disk will not take', () => {
  const diskFull = () => vi.spyOn(api, 'stashDraft').mockRejectedValue({ code: 'io', message: 'the disk is full' });
  const copyThem = "It isn't taking them just now, so copy what you want to keep.";

  /** Words typed with no stash working, newer text in, and the autosave has met it. */
  async function heldWithNoStash(): Promise<{ user: User; stash: ReturnType<typeof diskFull> }> {
    const user = await openEditor();
    const stash = diskFull();
    await user.click(box());
    await user.keyboard(' mine');
    await arrive();
    await pass(1000);
    expect(kind()).toBe('conflict');
    expect(stash).toHaveBeenCalled();
    expect(state.drafts['t-guide']).toBeUndefined();
    return { user, stash };
  }

  it('the notice in the editor makes no promise the disk has not kept', async () => {
    await heldWithNoStash();
    expect(saveState()).toHaveTextContent('If the app closes first, they come back as a notice at the next launch, if the disk takes them.');
    expect(saveState()).toHaveTextContent(copyThem);
  });

  it('nor does the banner with the editor closed', async () => {
    const { user } = await heldWithNoStash();
    await toggle(user);
    await pass(100);
    const banner = screen.getByTestId('held-banner');
    expect(banner).toHaveTextContent('If the app closes first, your words come back as a notice at the next launch, if the disk takes them.');
    expect(banner).toHaveTextContent(copyThem);
  });

  it('with the name held too, it says so of the description', async () => {
    const { user } = await heldWithNoStash();
    await user.type(nameBox(), ' v2');
    await arrive(() => {
      guide().name = 'Renamed elsewhere';
    });
    await pass(1000);
    expect(saveState()).toHaveTextContent('If the app closes first, the description comes back as a notice at the next launch, if the disk takes it, and the rest is lost.');
    expect(saveState()).toHaveTextContent("It isn't taking it just now, so copy what you want to keep.");
  });

  it('with only the name held, there are no words on the disk to speak of', async () => {
    const user = await openEditor();
    diskFull();
    await user.type(nameBox(), ' v2');
    await arrive(() => {
      guide().name = 'Renamed elsewhere';
    });
    await pass(1000);
    expect(kind()).toBe('conflict');
    expect(saveState()).toHaveTextContent('If the app closes first, they are lost.');
    expect(saveState()).not.toHaveTextContent('disk');
  });

  it('a stash that works again takes it all back, in the editor', async () => {
    const { user, stash } = await heldWithNoStash();
    stash.mockRestore();
    await user.keyboard(' more');
    await pass(400);
    expect(JSON.stringify(state.drafts['t-guide'])).toContain('more');
    expect(saveState()).toHaveTextContent('If the app closes first, they come back as a notice at the next launch.');
    expect(saveState()).not.toHaveTextContent('disk');
  });

  it('a stash that works again takes it all back, in the banner', async () => {
    const { user, stash } = await heldWithNoStash();
    await toggle(user);
    await pass(100);
    expect(screen.getByTestId('held-banner')).toHaveTextContent('if the disk takes them');
    stash.mockRestore();
    // The window hiding sends everything through a save again, and a held description gets another stash from that.
    await act(() => emit('flush-edits'));
    await pass(100);
    expect(JSON.stringify(state.drafts['t-guide'])).toContain('mine');
    expect(screen.getByTestId('held-banner')).toHaveTextContent('your words come back as a notice at the next launch.');
    expect(screen.getByTestId('held-banner')).not.toHaveTextContent('disk');
  });

  it('an editor opened on them again says so from the start', async () => {
    const { user } = await heldWithNoStash();
    await toggle(user);
    await pass(100);
    await toggle(user);
    expect(saveState()).toHaveTextContent('if the disk takes them');
  });

  it('it says nothing of a stash that failed under words that have since been saved', async () => {
    const user = await openEditor();
    diskFull();
    await user.click(box());
    await user.keyboard(' mine');
    await pass(1000);
    expect(kind()).toBe('saved');
    expect(storedText()).toContain('mine');
    expect(saveState()).not.toHaveTextContent('disk');
  });
});

describe('an edit the backend refuses for what it holds', () => {
  const tries = () => vi.mocked(api.patchTask).mock.calls.length;

  /** A name too long to store, in an open editor: refused, and not tried again by itself. */
  async function refusedName(): Promise<User> {
    const user = await openEditor();
    await user.type(nameBox(), 'x'.repeat(250));
    await pass(1000);
    expect(kind()).toBe('failed');
    const sent = tries();
    await pass(ALL_RETRIES_MS);
    expect(tries()).toBe(sent);
    return user;
  }

  it('goes again when it changes', async () => {
    const user = await refusedName();
    const sent = tries();
    await user.keyboard('y');
    await pass(1000);
    expect(tries()).toBeGreaterThan(sent);
  });

  it('goes again when its field is left', async () => {
    const user = await refusedName();
    const sent = tries();
    await user.click(box());
    await pass(100);
    expect(tries()).toBeGreaterThan(sent);
  });

  it('goes again when Done is pressed', async () => {
    const user = await refusedName();
    within(form()).getByRole('button', { name: 'Done' }).focus();
    await pass(100);
    const sent = tries();
    await user.keyboard('{Enter}');
    await pass(100);
    expect(tries()).toBeGreaterThan(sent);
    expect(editorOpen()).toBe(true);
  });

  it('goes again when the editor reopens', async () => {
    const user = await refusedName();
    await toggle(user);
    await pass(100);
    const sent = tries();
    await pass(ALL_RETRIES_MS);
    expect(tries()).toBe(sent);
    await toggle(user);
    await pass(1000);
    expect(tries()).toBeGreaterThan(sent);
  });

  it('goes again when the window hides or the app quits', async () => {
    await refusedName();
    const sent = tries();
    await act(() => emit('flush-edits'));
    await pass(100);
    expect(tries()).toBeGreaterThan(sent);
  });

  it('the README says when it goes again, and no fewer times than that', () => {
    const readme = readFileSync(path.resolve(import.meta.dirname, '../../../README.md'), 'utf8');
    const line = readme.split('\n').find((l) => l.startsWith('- A save that keeps failing')) ?? '';
    const refused = line.split("isn't retried")[1] ?? '';
    expect(refused).not.toContain('only');
    for (const when of ['change it', 'leave its field', 'press **Done**', 'the editor reopens', 'the window hides', 'the app quits']) expect(refused).toContain(when);
  });
});

describe('QC-F: a refused save that lands after the field was given up', () => {
  /** A rename on its way that the backend will refuse, as the name changed elsewhere first. */
  async function refusedRenameOnItsWay(): Promise<{ user: User; land: () => Promise<void> }> {
    const user = await openEditor();
    await user.type(nameBox(), ' v2');
    await arrive(() => {
      guide().name = 'Renamed elsewhere';
    });
    const release = gateNextSave();
    await pass(700);
    expect(vi.mocked(api.patchTask)).toHaveBeenCalled();
    return { user, land: () => act(async () => release()) };
  }

  it('Escape, then the reply: nothing is held, and typing goes on from the newer name', async () => {
    const { user, land } = await refusedRenameOnItsWay();
    await user.keyboard('{Escape}');
    expect(nameBox()).toHaveValue('Renamed elsewhere');
    await land();
    await pass(100);
    expect(kind()).not.toBe('conflict');
    await user.type(nameBox(), ' z');
    await pass(2000);
    expect(guide().name).toBe('Renamed elsewhere z');
    expect(kind()).toBe('saved');
    expect(discardButton()).toBeNull();
  });

  it('Escape and typing, then the reply: the same, as the typing goes on from what is shown', async () => {
    const { user, land } = await refusedRenameOnItsWay();
    await user.keyboard('{Escape}');
    await user.type(nameBox(), ' z');
    await land();
    await pass(2000);
    expect(guide().name).toBe('Renamed elsewhere z');
    expect(kind()).toBe('saved');
    expect(discardButton()).toBeNull();
  });

  it('with no Escape the reply still holds what was typed', async () => {
    const { land } = await refusedRenameOnItsWay();
    await land();
    await pass(2000);
    expect(guide().name).toBe('Renamed elsewhere');
    expect(nameBox()).toHaveValue('Brand guidelines v2');
    expect(kind()).toBe('conflict');
  });
});

describe('a press of Done just as the notice appears', () => {
  const doneButton = () => within(form()).getByRole('button', { name: 'Done' });
  /** Words typed, newer text in, Done focused, and the autosave has only just met it: the notice is up, unread. */
  async function justHeld(): Promise<User> {
    const user = await openEditor();
    await user.click(box());
    await user.keyboard(' mine');
    await arrive();
    doneButton().focus();
    await pass(600);
    expect(kind()).toBe('conflict');
    return user;
  }

  it('Enter chooses nothing, the notice stays, and Enter a second later saves', async () => {
    const user = await justHeld();
    await user.keyboard('{Enter}');
    await pass(100);
    expect(storedText()).toContain('From another');
    expect(storedText()).not.toContain('mine');
    expect(kind()).toBe('conflict');
    expect(saveState()).toHaveTextContent('changed elsewhere');
    expect(doneButton()).toHaveFocus();
    await pass(1000);
    await user.keyboard('{Enter}');
    await pass(100);
    expect(storedText()).toContain('mine');
    expect(editorOpen()).toBe(false);
  });

  it('a click chooses nothing either, and one a second later saves', async () => {
    const user = await justHeld();
    await user.click(doneButton());
    await pass(100);
    expect(storedText()).not.toContain('mine');
    expect(kind()).toBe('conflict');
    await pass(1000);
    await user.click(doneButton());
    await pass(100);
    expect(storedText()).toContain('mine');
    expect(editorOpen()).toBe(false);
  });

  it('the first Enter of a save that brings the notice on leaves a second Enter unread too', async () => {
    const user = await openEditor();
    await user.click(box());
    await user.keyboard(' mine');
    await arrive();
    doneButton().focus();
    await user.keyboard('{Enter}');
    await pass(0);
    expect(kind()).toBe('conflict');
    await user.keyboard('{Enter}');
    await pass(100);
    expect(storedText()).not.toContain('mine');
    expect(kind()).toBe('conflict');
  });

  it('renders while the notice is up do not give it its second again', async () => {
    const user = await justHeld();
    // The page hears of something every 300 ms, as it does with a task running, and the editor renders each time.
    for (let i = 0; i < 4; i++) {
      await arrive(() => undefined);
      await pass(200);
    }
    await user.click(doneButton());
    await pass(100);
    expect(storedText()).toContain('mine');
    expect(editorOpen()).toBe(false);
  });

  it('typing on does not make the notice any newer', async () => {
    const user = await holdWords();
    await user.click(box());
    await user.keyboard(' more');
    await pass(100);
    await user.click(doneButton());
    await pass(100);
    expect(storedText()).toContain('more');
  });

  it('a field held later has its own second, and the one read goes', async () => {
    const user = await holdWords();
    await user.click(nameBox());
    await user.keyboard(' renamed');
    await arrive(() => {
      guide().name = 'Renamed elsewhere';
    });
    await pass(600);
    expect(heldNow()).toEqual(['name', 'description']);
    await user.click(doneButton());
    await pass(100);
    expect(storedText()).toContain('mine');
    expect(guide().name).toBe('Renamed elsewhere');
    expect(editorOpen()).toBe(true);
    expect(saveState()).toHaveTextContent('name');
    await pass(1000);
    await user.click(doneButton());
    await pass(100);
    expect(guide().name).toContain('renamed');
    expect(editorOpen()).toBe(false);
  });

  it('coming back to an editor is a notice appearing again', async () => {
    const user = await holdWords();
    await toggle(user);
    await pass(2000);
    await toggle(user);
    await pass(10);
    expect(kind()).toBe('conflict');
    await user.click(doneButton());
    await pass(100);
    expect(storedText()).not.toContain('mine');
    expect(kind()).toBe('conflict');
    await pass(1000);
    await user.click(doneButton());
    await pass(100);
    expect(storedText()).toContain('mine');
  });

  it('a Space held down across the second is one press, and chose nothing', async () => {
    const user = await justHeld();
    // Space clicks when it comes up. This one went down inside the notice's first second and comes up after it.
    await user.keyboard('[Space>]');
    await pass(1000);
    await user.keyboard('[/Space]');
    await pass(100);
    expect(storedText()).toContain('From another');
    expect(storedText()).not.toContain('mine');
    expect(kind()).toBe('conflict');
    expect(editorOpen()).toBe(true);
    expect(doneButton()).toHaveFocus();
    // A Space pressed and let go after the second is the choice.
    await user.keyboard('[Space]');
    await pass(100);
    expect(storedText()).toContain('mine');
    expect(editorOpen()).toBe(false);
  });

  it('a Space that went down on Done and never came up there speaks for no later click', async () => {
    const user = await holdWords();
    await act(async () => doneButton().focus());
    // Space goes down on Done with the notice read, and focus leaves before it comes up, so it never clicks.
    fireEvent.keyDown(doneButton(), { key: ' ', code: 'Space' });
    await user.click(discardButton() as HTMLElement);
    await user.click(box());
    await user.keyboard(' again');
    await arrive(() => {
      guide().description = { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Newer still' }] }] };
    });
    while (kind() !== 'conflict') await pass(10);
    // A new notice, unread, and a click with no pointer or key of its own behind it.
    fireEvent.click(doneButton());
    await pass(100);
    expect(storedText()).toContain('Newer still');
    expect(storedText()).not.toContain('again');
    expect(editorOpen()).toBe(true);
    expect(kind()).toBe('conflict');
  });
});

describe('a double click on Done around the second of a notice', () => {
  const doneButton = () => within(form()).getByRole('button', { name: 'Done' });
  /** Words typed, newer text in, and the autosave has only just met it, with focus still in the description: the notice is up, unread, and Done is yet to be pressed. */
  async function heldByAutosave(): Promise<User> {
    const user = await openEditor();
    await user.click(box());
    await user.keyboard(' mine');
    await arrive();
    while (kind() !== 'conflict') await pass(10);
    return user;
  }
  /** One mouse press on Done, as the browser sends it. `detail` is its count of clicks in a run: 2 for the second of a double click. */
  async function mouse(detail: number): Promise<void> {
    const button = doneButton();
    fireEvent.pointerDown(button);
    fireEvent.mouseDown(button, { detail });
    // The mouse down moves focus, once the handlers of the press have run.
    await act(async () => button.focus());
    fireEvent.pointerUp(button);
    fireEvent.mouseUp(button, { detail });
    fireEvent.click(button, { detail });
  }

  it('chooses nothing for a notice its first click found unread, though its second click falls after the second', async () => {
    const user = await heldByAutosave();
    await pass(700);
    await mouse(1);
    await pass(350);
    await mouse(2);
    await pass(100);
    expect(storedText()).toContain('From another');
    expect(storedText()).not.toContain('mine');
    expect(editorOpen()).toBe(true);
    expect(kind()).toBe('conflict');
    // A click on its own after that is the choice.
    await pass(1000);
    await done(user);
    await pass(100);
    expect(storedText()).toContain('mine');
    expect(editorOpen()).toBe(false);
  });

  it('counts the third click of a run, which comes after the second', async () => {
    await heldByAutosave();
    await pass(600);
    await mouse(1);
    await pass(300);
    await mouse(2);
    await pass(300);
    await mouse(3);
    await pass(100);
    expect(storedText()).toContain('mine');
    expect(editorOpen()).toBe(false);
  });

  it('with two fields held, sends the one its first click found read and not the one it found unread', async () => {
    const user = await openEditor();
    await user.type(nameBox(), ' v2');
    await arrive(() => {
      guide().name = 'Renamed elsewhere';
    });
    await pass(1000);
    expect(kind()).toBe('conflict');
    await pass(HOLD_READ_MS);
    await user.click(box());
    await user.keyboard(' mine');
    await arrive();
    while (!heldNow().includes('description')) await pass(10);
    await pass(700);
    // The name's notice has been up long enough to read, and the words' has not.
    await mouse(1);
    await pass(350);
    await mouse(2);
    await pass(100);
    expect(guide().name).toBe('Brand guidelines v2');
    expect(storedText()).toContain('From another');
    expect(storedText()).not.toContain('mine');
    expect(editorOpen()).toBe(true);
    expect(saveState()).toHaveTextContent('description');
    await pass(1000);
    await done(user);
    await pass(100);
    expect(storedText()).toContain('mine');
    expect(editorOpen()).toBe(false);
  });
});

describe('QC-G: a press on Done dragged off the button', () => {
  const doneButton = () => within(form()).getByRole('button', { name: 'Done' });
  /** Pressed on Done and released elsewhere: no click comes of it. */
  async function pressAndDragOff(user: User) {
    await user.pointer([{ target: doneButton(), keys: '[MouseLeft>]' }]);
    await user.pointer([{ target: document.body }, { keys: '[/MouseLeft]' }]);
    await pass(10);
    expect(editorOpen()).toBe(true);
  }
  const pressEnterOnDone = async (user: User) => {
    await act(async () => doneButton().focus());
    await user.keyboard('{Enter}');
  };

  it('leaves no list behind: a later keyboard press sends what is held by then', async () => {
    const user = await openEditor();
    await pressAndDragOff(user);
    await user.click(box());
    await user.keyboard(' mine');
    await arrive();
    await pass(1000);
    expect(kind()).toBe('conflict');
    await pass(HOLD_READ_MS);
    await pressEnterOnDone(user);
    await pass(2000);
    expect(storedText()).toContain('mine');
    expect(editorOpen()).toBe(false);
  });

  it('leaves no list behind: a later keyboard press never sends a hold that only its own blur brought', async () => {
    const user = await holdWords();
    await pressAndDragOff(user);
    await user.click(discardButton() as HTMLElement);
    await user.click(box());
    await user.keyboard(' again');
    await arrive(() => {
      guide().description = { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Newer still' }] }] };
    });
    // The blur of moving to the button sends the words. The reply comes only after the key.
    const release = gateNextSave();
    await pressEnterOnDone(user);
    await act(async () => release());
    await pass(2000);
    expect(storedText()).toContain('Newer still');
    expect(storedText()).not.toContain('again');
    expect(editorOpen()).toBe(true);
    expect(kind()).toBe('conflict');
  });

  it('a real click still sends only what was held before the press', async () => {
    const user = await holdWords();
    await pressAndDragOff(user);
    await done(user);
    await pass(2000);
    expect(storedText()).toContain('mine');
    expect(editorOpen()).toBe(false);
  });
});

describe('found in review', () => {
  it('a field saved while another is typed in is done with, so a newer value for it just shows', async () => {
    const user = await openEditor();
    const land = gateNextSave();
    await user.type(nameBox(), ' v2');
    await user.click(box());
    await pass(10);
    await user.keyboard(' x');
    await act(async () => land());
    await pass(10);
    await arrive(() => {
      guide().name = 'Renamed elsewhere';
    });
    expect(nameBox()).toHaveValue('Renamed elsewhere');
    await pass(2000);
    expect(guide().name).toBe('Renamed elsewhere');
    expect(storedText()).toContain(' x');
    expect(kind()).toBe('saved');
  });

  it('a click alone saves nothing, even where the editor adds a paragraph of its own', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime.bind(vi) });
    state = demoState();
    guide().description = { type: 'doc', content: [{ type: 'bulletList', content: [{ type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'One' }] }] }] }] };
    bootApp(state);
    await user.click(await screen.findByRole('button', { name: 'Edit Brand guidelines' }));
    await user.click(box());
    await pass(2000);
    await user.tab();
    await pass(2000);
    expect(countOf('patch_task')).toBe(0);
    expect(countOf('stash_draft')).toBe(0);
  });

  it('no draft outlives the save that holds its words, however the saves queued', async () => {
    const user = await openEditor();
    await user.click(box());
    const land = gateNextSave();
    await user.keyboard(' one');
    await pass(700);
    await user.keyboard(' two');
    await pass(700);
    await user.keyboard(' three');
    await act(async () => land());
    await pass(2000);
    expect(storedText()).toContain('one two three');
    expect(kind()).toBe('saved');
    expect(state.drafts['t-guide']).toBeUndefined();
  });

  it('Escape during a save of the name ends up showing what the store holds', async () => {
    const user = await openEditor();
    const land = gateNextSave();
    await user.type(nameBox(), ' v2');
    await pass(700);
    await user.keyboard('{Escape}');
    expect(nameBox()).toHaveValue('Brand guidelines');
    await act(async () => land());
    await pass(100);
    expect(guide().name).toBe('Brand guidelines v2');
    expect(nameBox()).toHaveValue('Brand guidelines v2');
  });

  it('the same words stored with their keys in another order are no conflict on reopening', async () => {
    const sorted = (v: unknown): unknown =>
      Array.isArray(v) ? v.map(sorted) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b)).map(([k, x]) => [k, sorted(x)])) : v;
    const user = await openEditor();
    await user.click(box());
    await user.keyboard(' mine');
    storeDown = true;
    await toggle(user);
    await pass(500);
    const words = state.drafts['t-guide'];
    expect(JSON.stringify(words)).toContain('mine');
    storeDown = false;
    guide().description = sorted(words) as never;
    await act(() => emit('state-changed'));
    await pass(100);
    await toggle(user);
    expect(kind()).not.toBe('conflict');
    await pass(2000);
    expect(kind()).toBe('saved');
  });
});
