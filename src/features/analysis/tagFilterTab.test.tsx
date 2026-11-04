// "No tag" in the tag filter of the Analysis tab, with the whole app and its mock backend behind it. A tag that is deleted
// while it is chosen is dropped from the filter (with none of it left, the screen would show no time at all); "No tag"
// is not a tag and cannot be deleted, so the tab keeps it, and every figure follows it.
import { emit } from '@tauri-apps/api/event';
import { clearMocks } from '@tauri-apps/api/mocks';
import { act, cleanup, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { boot, polyfillDom } from '../../components/testKit';
import { demoState } from '../../mocks/demoSeed';
import { handle, type MockState } from '../../mocks/ipcMock';

beforeEach(polyfillDom);
afterEach(() => {
  cleanup();
  clearMocks();
  vi.restoreAllMocks();
});

const settle = async (): Promise<void> => {
  for (let i = 0; i < 6; i += 1) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 10));
    });
  }
};

/** The demo with Homepage layout, the only task of Website, tagged Revision: every other task has no tag. */
async function openAnalysis(): Promise<{ s: MockState; user: ReturnType<typeof userEvent.setup>; panel: HTMLElement }> {
  const s = demoState();
  handle(s, 'patch_task', { id: 't-home', patch: { tags: ['tag-revision'] } });
  const user = userEvent.setup();
  boot(s);
  await user.click(await screen.findByRole('tab', { name: 'Analysis' }));
  await settle();
  return { s, user, panel: screen.getByRole('tabpanel') };
}

const legend = (panel: HTMLElement): string => within(panel).getByRole('list', { name: 'Share of time legend, projects' }).textContent ?? '';

describe('the "No tag" choice in the Analysis tab', () => {
  it('stays chosen, and the figures keep only the time of tasks with no tag', { timeout: 15_000 }, async () => {
    const { user, panel } = await openAnalysis();
    expect(legend(panel)).toContain('Website');

    await user.click(within(panel).getByRole('checkbox', { name: 'No tag' }));
    await settle();
    expect(within(panel).getByRole('checkbox', { name: 'No tag' })).toBeChecked();
    expect(panel.querySelector('.a-tag-hint')).toHaveTextContent('Tasks with no tag');
    expect(within(panel).getByRole('button', { name: 'Clear filters' })).toBeVisible();
    expect(legend(panel)).not.toContain('Website');
    expect(legend(panel)).toContain('Brand refresh');

    // Choosing a tag as well keeps that tag's tasks too, and "No tag" stays.
    await user.click(within(panel).getByRole('checkbox', { name: /Revision/ }));
    await settle();
    expect(within(panel).getByRole('checkbox', { name: 'No tag' })).toBeChecked();
    expect(panel.querySelector('.a-tag-hint')).toHaveTextContent('Tasks with any selected tag, or with no tag');
    expect(legend(panel)).toContain('Website');
  });

  it('is not dropped when a tag that was chosen with it is deleted', { timeout: 15_000 }, async () => {
    const { s, user, panel } = await openAnalysis();
    await user.click(within(panel).getByRole('checkbox', { name: 'No tag' }));
    await user.click(within(panel).getByRole('checkbox', { name: /Revision/ }));
    await settle();
    handle(s, 'delete_tag', { id: 'tag-revision' });
    await act(async () => {
      await emit('state-changed');
    });
    await settle();
    // The deleted tag leaves the filter; "No tag" stays.
    expect(within(panel).getByRole('checkbox', { name: 'No tag' })).toBeChecked();
    expect(panel.querySelector('.a-tag-hint')).toHaveTextContent('Tasks with no tag');
  });
});
