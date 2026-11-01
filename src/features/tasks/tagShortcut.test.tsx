// "New tag" next to the tag picker: Settings > Tags opens with the Add tag form focused, the unsaved task is
// untouched, a way back is on screen, and the tag made on the way is ticked.
import { clearMocks } from '@tauri-apps/api/mocks';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { boot, polyfillDom } from '../../components/testKit';
import { emptyState, type MockState } from '../../mocks/ipcMock';

beforeEach(polyfillDom);
afterEach(() => clearMocks());

function noTags(): MockState {
  const s = emptyState('2026-03-12T15:20:00Z');
  s.projects.push({ id: 'p1', name: 'Brand refresh', color: '#2563eb', archived: false, billable: true, budgetHours: null, clientZone: null, createdAt: '2026-01-01T00:00:00Z', hasTasks: false });
  s.tags = [];
  return s;
}

async function startForm(s: MockState) {
  const user = userEvent.setup();
  boot(s);
  await user.click(await screen.findByRole('button', { name: 'New task' }));
  const form = screen.getByRole('form', { name: 'New task' });
  await user.type(within(form).getByRole('textbox', { name: 'Task name' }), 'Draft logo');
  await user.selectOptions(within(form).getByRole('combobox', { name: 'Project' }), 'p1');
  await user.type(within(form).getByRole('textbox', { name: 'Description' }), 'Three directions');
  return { user, form };
}

describe('tag shortcut', () => {
  it('opens Settings > Tags with the Add tag form open and the cursor in its name, and the task text is kept', async () => {
    const { user, form } = await startForm(noTags());
    await user.click(within(form).getByRole('button', { name: 'New tag' }));
    const editor = await screen.findByRole('form', { name: 'New tag' });
    await waitFor(() => expect(within(editor).getByRole('textbox', { name: 'Tag name' })).toHaveFocus());
    // Obvious way back, naming what is kept.
    const bar = screen.getByTestId('back-to-task-bar');
    expect(within(bar).getByRole('button', { name: 'Back to task' })).toBeVisible();
    expect(bar).toHaveTextContent('What you typed there is kept');
    // The task form is still there, untouched.
    expect(within(screen.getByRole('form', { name: 'New task' })).getByRole('textbox', { name: 'Task name' })).toHaveValue('Draft logo');
    expect(within(screen.getByRole('form', { name: 'New task' })).getByRole('textbox', { name: 'Description' })).toHaveTextContent('Three directions');
  });

  it('works from the keyboard: Enter on New tag, Enter in the name saves, Back to task takes the focus', async () => {
    const { user, form } = await startForm(noTags());
    within(form).getByRole('button', { name: 'New tag' }).focus();
    await user.keyboard('{Enter}');
    const editor = await screen.findByRole('form', { name: 'New tag' });
    await waitFor(() => expect(within(editor).getByRole('textbox', { name: 'Tag name' })).toHaveFocus());
    await user.keyboard('Sketch{Enter}');
    const back = await screen.findByRole('button', { name: 'Back to task' });
    await waitFor(() => expect(back).toHaveFocus());
    await user.keyboard('{Enter}');
    // Back on the task's own tab, with the cursor in its tag picker.
    expect(await screen.findByRole('tab', { name: 'Timeline', selected: true })).toBeVisible();
    await waitFor(() => expect(within(screen.getByRole('form', { name: 'New task' })).getByRole('checkbox', { name: 'Sketch' })).toHaveFocus());
  });

  it('ticks the new tag so the required-tag rule is met, and Start becomes available', async () => {
    const s = noTags();
    const { user, form } = await startForm(s);
    // With no tags, nothing requires one yet.
    expect(within(form).getByRole('button', { name: 'Start' })).toBeEnabled();
    await user.click(within(form).getByRole('button', { name: 'New tag' }));
    await user.type(await screen.findByRole('textbox', { name: 'Tag name' }), 'Sketch');
    await user.click(screen.getByRole('button', { name: 'Add tag' }));
    // The notice with the way back stays up after the tag is made, and says it is ticked.
    const bar = await screen.findByTestId('back-to-task-bar');
    expect(bar).toHaveTextContent('Tag added and ticked on your task');
    await user.click(await within(bar).findByRole('button', { name: 'Back to task' }));
    const task = await screen.findByRole('form', { name: 'New task' });
    const box = await within(task).findByRole('checkbox', { name: 'Sketch' });
    await waitFor(() => expect(box).toBeChecked());
    expect(within(task).getByRole('button', { name: 'Start' })).toBeEnabled();
    expect(screen.queryByTestId('back-to-task-bar')).toBeNull();
    // The user may untick it afterwards: it is not forced back on.
    await user.click(box);
    expect(box).not.toBeChecked();
  });

  it('Back to task without making a tag leaves everything as it was', async () => {
    const { user, form } = await startForm(noTags());
    await user.click(within(form).getByRole('button', { name: 'New tag' }));
    await user.click(await screen.findByRole('button', { name: 'Back to task' }));
    const task = await screen.findByRole('form', { name: 'New task' });
    expect(within(task).getByRole('textbox', { name: 'Task name' })).toHaveValue('Draft logo');
    expect(within(task).queryAllByRole('checkbox')).toEqual([]);
  });
});
