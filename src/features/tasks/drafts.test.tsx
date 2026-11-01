// Last-moment edits: what is typed into a task's description is stashed on disk within a fraction of a second,
// well before the autosave, and cleared once the real save has landed.
import { clearMocks } from '@tauri-apps/api/mocks';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { boot as bootApp, polyfillDom } from '../../components/testKit';
import { api } from '../../lib/api';
import { demoState } from '../../mocks/demoSeed';
import type { MockState } from '../../mocks/ipcMock';
import { AUTOSAVE_MS, DRAFT_MS } from './TaskEditor';

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
const calls = (cmd: string) => state.calls.filter((c) => c.cmd === cmd);

/** The autosave runs on the real clock, so a stalled runner can fire it between two keys. This keeps it from firing. */
function holdAutosave(): void {
  const real = window.setTimeout;
  vi.spyOn(window, 'setTimeout').mockImplementation(((fn: TimerHandler, ms?: number, ...rest: unknown[]) =>
    ms === AUTOSAVE_MS ? 0 : real(fn, ms, ...rest)) as typeof window.setTimeout);
}

async function openEditor() {
  const user = userEvent.setup();
  boot(demoState());
  await user.click(await screen.findByRole('button', { name: 'Edit Brand guidelines' }));
  const form = screen.getByRole('form', { name: 'Editing Brand guidelines' });
  return { user, form, box: within(form).getByRole('textbox', { name: 'Description' }) };
}

describe('description drafts', () => {
  it('the stash comes well before the autosave, and costs one write for a burst of typing', async () => {
    expect(DRAFT_MS).toBeLessThanOrEqual(300);
    expect(DRAFT_MS).toBeLessThan(AUTOSAVE_MS);
    const { user, box } = await openEditor();
    await user.click(box);
    await user.keyboard(' unsaved words');
    expect(calls('patch_task')).toHaveLength(0);
    await waitFor(() => expect(calls('stash_draft').length).toBeGreaterThan(0), { timeout: AUTOSAVE_MS });
    expect(calls('patch_task')).toHaveLength(0);
    expect(calls('stash_draft')).toHaveLength(1);
    expect(JSON.stringify(state.drafts['t-guide'])).toContain('unsaved words');
  });

  it('is cleared once the real save has landed, and not before', async () => {
    const { user, box, form } = await openEditor();
    await user.click(box);
    await user.paste(' second thoughts');
    await waitFor(() => expect(state.drafts['t-guide']).toBeDefined());
    await waitFor(() => expect(calls('patch_task')).toHaveLength(1), { timeout: 3000 });
    await waitFor(() => expect(within(form).getByTestId('save-state')).toHaveTextContent('Saved'));
    await waitFor(() => expect(state.drafts['t-guide']).toBeUndefined());
    // Cleared after the save, never before it.
    const order = state.calls.map((c) => c.cmd).filter((c) => ['stash_draft', 'patch_task', 'clear_draft'].includes(c));
    expect(order).toEqual(['stash_draft', 'patch_task', 'clear_draft']);
  });

  it('closing the editor right away writes the draft first, then saves', async () => {
    const { user, box, form } = await openEditor();
    holdAutosave();
    await user.click(box);
    await user.keyboard(' last second');
    await user.click(within(form).getByRole('button', { name: 'Done' }));
    await waitFor(() => expect(calls('patch_task')).toHaveLength(1));
    expect(JSON.stringify(calls('patch_task')[0])).toContain('last second');
    const order = state.calls.map((c) => c.cmd).filter((c) => ['stash_draft', 'patch_task', 'clear_draft'].includes(c));
    expect(order.indexOf('stash_draft')).toBeGreaterThanOrEqual(0);
    expect(order.indexOf('stash_draft')).toBeLessThan(order.indexOf('patch_task'));
    await waitFor(() => expect(state.drafts['t-guide']).toBeUndefined());
  });

  it('a draft that cannot be written never breaks editing or the real save', async () => {
    vi.spyOn(api, 'stashDraft').mockRejectedValue({ code: 'io', message: 'disk full' });
    const { user, box, form } = await openEditor();
    await user.click(box);
    await user.paste(' still saved');
    await waitFor(() => expect(calls('patch_task')).toHaveLength(1), { timeout: 3000 });
    await waitFor(() => expect(within(form).getByTestId('save-state')).toHaveTextContent('Saved'));
    expect(JSON.stringify(state.tasks.find((t) => t.id === 't-guide')?.description)).toContain('still saved');
  });

  it('typing again while a save is under way keeps the newer draft', async () => {
    const { user, box } = await openEditor();
    await user.click(box);
    await user.paste(' one');
    await waitFor(() => expect(calls('patch_task')).toHaveLength(1), { timeout: 3000 });
    await user.paste(' two');
    await waitFor(() => expect(JSON.stringify(state.drafts['t-guide'] ?? null)).toContain('two'));
    await waitFor(() => expect(calls('patch_task')).toHaveLength(2), { timeout: 3000 });
    await waitFor(() => expect(state.drafts['t-guide']).toBeUndefined());
  });
});
