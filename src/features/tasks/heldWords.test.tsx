// The rule, through the real editor and the mock backend: an automatic save never silently overwrites text
// the user has not seen, and the user's own unsaved words never vanish silently. QC-n names the gate finding
// each case came from.
import { emit } from '@tauri-apps/api/event';
import { clearMocks } from '@tauri-apps/api/mocks';
import { act, cleanup, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { boot as bootApp, polyfillDom } from '../../components/testKit';
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

/** Another device's text lands in the store, and this page hears of it. */
async function arrive(change: () => void = () => void (guide().description = elsewhere)) {
  change();
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

/** Words typed, newer text in, and the autosave has met it: the notice is on screen. */
async function holdWords(): Promise<User> {
  const user = await openEditor();
  await user.click(box());
  await user.keyboard(' mine');
  await arrive();
  await pass(1000);
  expect(kind()).toBe('conflict');
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

describe('an edit to a task deleted elsewhere', () => {
  const noticesShown = () => screen.queryAllByTestId('notice').map((n) => n.textContent ?? '');
  async function deleteIt() {
    state.tasks = state.tasks.filter((t) => t.id !== 't-guide');
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

describe('found in review', () => {
  /** The next save waits at the backend's door until `land` is called. */
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
