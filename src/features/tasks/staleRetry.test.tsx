// A save that fails as the editor closes keeps being retried after it has gone. Those retries must never
// put old text over something newer, and the edit that failed must still reach the store or the user.
import { emit } from '@tauri-apps/api/event';
import { clearMocks } from '@tauri-apps/api/mocks';
import { act, cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { boot as bootApp, polyfillDom } from '../../components/testKit';
import { api } from '../../lib/api';
import { demoState } from '../../mocks/demoSeed';
import type { MockState } from '../../mocks/ipcMock';

/** Longer than the five retries added up: 2 + 4 + 8 + 16 + 32 seconds. */
const ALL_RETRIES_MS = 70_000;

let state: MockState;
let storeDown: boolean;
let attempts: number;

beforeEach(() => {
  polyfillDom();
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'], shouldAdvanceTime: true });
  storeDown = false;
  attempts = 0;
  const real = api.patchTask;
  vi.spyOn(api, 'patchTask').mockImplementation((...args) => {
    attempts += 1;
    return storeDown ? Promise.reject({ code: 'io', message: 'the data file is locked' }) : real(...args);
  });
});

afterEach(async () => {
  cleanup();
  await act(() => vi.advanceTimersByTimeAsync(ALL_RETRIES_MS));
  clearMocks();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const saved = () => JSON.stringify(state.tasks.find((t) => t.id === 't-guide')?.description);
const pass = (ms: number) => act(() => vi.advanceTimersByTimeAsync(ms));
const form = () => screen.getByRole('form', { name: 'Editing Brand guidelines' });
const box = () => within(form()).getByRole('textbox', { name: 'Description' });
const toggleEditor = (user: ReturnType<typeof userEvent.setup>) => user.click(screen.getByRole('button', { name: 'Edit Brand guidelines' }));

/** Boots, types into the description, and closes the editor with the card's button while the store is refusing saves. */
async function closeOnAFailedSave(words: string) {
  const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime.bind(vi) });
  state = demoState();
  bootApp(state);
  await user.click(await screen.findByRole('button', { name: 'Edit Brand guidelines' }));
  await user.click(box());
  await user.keyboard(words);
  storeDown = true;
  await toggleEditor(user);
  expect(screen.queryByRole('form', { name: 'Editing Brand guidelines' })).toBeNull();
  await waitFor(() => expect(attempts).toBeGreaterThan(0));
  expect(saved()).not.toContain(words.trim());
  return user;
}

describe('a save that failed as the editor closed', () => {
  it('its retry never overwrites newer text typed after reopening, and the failed words survive too', async () => {
    const user = await closeOnAFailedSave(' failed words');
    await toggleEditor(user);
    storeDown = false;
    await user.click(box());
    await user.keyboard(' newer words');
    await waitFor(() => expect(saved()).toContain('newer words'));
    await pass(ALL_RETRIES_MS);
    expect(saved()).toContain('newer words');
    expect(saved()).toContain('failed words');
  });

  it('reopening shows the words that were not saved', async () => {
    const user = await closeOnAFailedSave(' failed words');
    await toggleEditor(user);
    expect(box()).toHaveTextContent('failed words');
  });

  it('still reaches the store by itself once saves work again, and leaves no draft behind', async () => {
    await closeOnAFailedSave(' failed words');
    await waitFor(() => expect(state.drafts['t-guide']).toBeDefined());
    storeDown = false;
    await pass(ALL_RETRIES_MS);
    expect(saved()).toContain('failed words');
    await waitFor(() => expect(state.drafts['t-guide']).toBeUndefined());
  });

  it('stops trying after the last retry, and keeps the words for when the task is reopened', async () => {
    const user = await closeOnAFailedSave(' failed words');
    await pass(ALL_RETRIES_MS);
    const tries = attempts;
    await pass(ALL_RETRIES_MS);
    expect(attempts).toBe(tries);
    expect(JSON.stringify(state.drafts['t-guide'])).toContain('failed words');

    await toggleEditor(user);
    expect(box()).toHaveTextContent('failed words');
    storeDown = false;
    await user.click(screen.getByRole('button', { name: 'Done' }));
    await waitFor(() => expect(saved()).toContain('failed words'));
    await waitFor(() => expect(screen.queryByRole('form', { name: 'Editing Brand guidelines' })).toBeNull());
  });

  it('is sent again at once when the window hides, even with the editor closed', async () => {
    await closeOnAFailedSave(' failed words');
    storeDown = false;
    const hidden = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    document.dispatchEvent(new Event('visibilitychange'));
    hidden.mockRestore();
    await waitFor(() => expect(saved()).toContain('failed words'));
  });

  it('once it has landed, the next opening starts from the stored task', async () => {
    const user = await closeOnAFailedSave(' failed words');
    storeDown = false;
    await pass(ALL_RETRIES_MS);
    await api.patchTask('t-guide', { description: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'From another device' }] }] } });
    await act(() => emit('state-changed'));
    await pass(100);
    await toggleEditor(user);
    expect(box()).toHaveTextContent('From another device');
  });

  it('a blank name is never kept for the next opening', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime.bind(vi) });
    state = demoState();
    bootApp(state);
    await user.click(await screen.findByRole('button', { name: 'Edit Brand guidelines' }));
    const name = within(form()).getByRole('textbox', { name: 'Task name' });
    await user.clear(name);
    await user.click(box());
    await user.keyboard(' failed words');
    storeDown = true;
    await toggleEditor(user);
    await toggleEditor(user);
    expect(within(form()).getByRole('textbox', { name: 'Task name' })).toHaveValue('Brand guidelines');
    expect(box()).toHaveTextContent('failed words');
  });

  it('a name changed elsewhere meanwhile shows on reopening, next to the words still unsaved', async () => {
    const user = await closeOnAFailedSave(' failed words');
    const guide = state.tasks.find((t) => t.id === 't-guide');
    if (guide) guide.name = 'Renamed elsewhere';
    await act(() => emit('state-changed'));
    await pass(100);
    await user.click(screen.getByRole('button', { name: 'Edit Renamed elsewhere' }));
    const reopened = screen.getByRole('form', { name: 'Editing Renamed elsewhere' });
    expect(within(reopened).getByRole('textbox', { name: 'Task name' })).toHaveValue('Renamed elsewhere');
    expect(within(reopened).getByRole('textbox', { name: 'Description' })).toHaveTextContent('failed words');
  });

  describe('when newer text arrives from elsewhere meanwhile', () => {
    const elsewhere = { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'From another device' }] }] };
    async function newerElsewhere(words: string) {
      const user = await closeOnAFailedSave(words);
      const guide = state.tasks.find((t) => t.id === 't-guide');
      if (guide) guide.description = elsewhere;
      await act(() => emit('state-changed'));
      await pass(100);
      storeDown = false;
      return user;
    }

    it('the retry leaves the newer text alone', async () => {
      await newerElsewhere(' failed words');
      await pass(ALL_RETRIES_MS);
      expect(saved()).toContain('From another device');
      expect(saved()).not.toContain('failed words');
      expect(screen.getByRole('alert')).toHaveTextContent('changed elsewhere');
    });

    it('so does the save when the window hides', async () => {
      await newerElsewhere(' failed words');
      const hidden = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
      document.dispatchEvent(new Event('visibilitychange'));
      hidden.mockRestore();
      await pass(100);
      expect(saved()).toContain('From another device');
    });

    it('reopening shows the words and says so, and sends nothing until the user chooses', async () => {
      const user = await newerElsewhere(' failed words');
      await pass(ALL_RETRIES_MS);
      await toggleEditor(user);
      expect(box()).toHaveTextContent('failed words');
      expect(within(form()).getByTestId('save-state')).toHaveTextContent('changed elsewhere');
      await pass(ALL_RETRIES_MS);
      expect(saved()).toContain('From another device');
      await user.click(screen.getByRole('button', { name: 'Done' }));
      await waitFor(() => expect(saved()).toContain('failed words'));
      expect(saved()).not.toContain('From another device');
    });

    it('its other unsaved fields still go, and the words stay', async () => {
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime.bind(vi) });
      state = demoState();
      bootApp(state);
      await user.click(await screen.findByRole('button', { name: 'Edit Brand guidelines' }));
      await user.type(within(form()).getByRole('textbox', { name: 'Task name' }), ' v2');
      await user.click(box());
      await user.keyboard(' failed words');
      storeDown = true;
      await user.click(screen.getByRole('button', { name: 'Edit Brand guidelines v2' }));
      const guide = state.tasks.find((t) => t.id === 't-guide');
      if (guide) guide.description = elsewhere;
      storeDown = false;
      await pass(ALL_RETRIES_MS);
      expect(guide?.name).toBe('Brand guidelines v2');
      expect(saved()).toContain('From another device');
    });
  });

  it('a task deleted elsewhere stops the retries and leaves no draft', async () => {
    await closeOnAFailedSave(' failed words');
    storeDown = false;
    await waitFor(() => expect(state.drafts['t-guide']).toBeDefined());
    state.tasks = state.tasks.filter((t) => t.id !== 't-guide');
    await pass(ALL_RETRIES_MS);
    const tries = attempts;
    const hidden = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    document.dispatchEvent(new Event('visibilitychange'));
    hidden.mockRestore();
    await pass(ALL_RETRIES_MS);
    expect(attempts).toBe(tries);
    expect(state.drafts['t-guide']).toBeUndefined();
  });

  it('closing one editor does not send another outside its backoff', async () => {
    const user = await closeOnAFailedSave(' failed words');
    await toggleEditor(user);
    await pass(100);
    await user.click(within(form()).getByRole('textbox', { name: 'Task name' }));
    const other = screen.getByRole('button', { name: 'Edit Logo concepts' });
    await user.click(other);
    await pass(100);
    const tries = attempts;
    await user.click(screen.getByRole('button', { name: 'Edit Logo concepts' }));
    await pass(100);
    expect(attempts).toBe(tries);
  });

  it('a save that fails after reopening shows in the new editor, and keeps retrying through it', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime.bind(vi) });
    state = demoState();
    bootApp(state);
    await user.click(await screen.findByRole('button', { name: 'Edit Brand guidelines' }));
    await user.click(box());
    await user.keyboard(' failed words');
    let fail: (reason: unknown) => void = () => undefined;
    vi.mocked(api.patchTask).mockImplementationOnce(() => new Promise((_, reject) => { fail = reject; }));
    await toggleEditor(user);
    await toggleEditor(user);
    storeDown = true;
    await act(async () => fail({ code: 'io', message: 'the data file is locked' }));
    await pass(100);
    expect(within(form()).getByTestId('save-state')).toHaveTextContent('Not saved');
    storeDown = false;
    await pass(ALL_RETRIES_MS);
    expect(within(form()).getByTestId('save-state')).toHaveTextContent('Saved');
    expect(saved()).toContain('failed words');
  });
});
