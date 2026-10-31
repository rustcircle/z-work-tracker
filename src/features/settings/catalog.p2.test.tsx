import { clearMocks } from '@tauri-apps/api/mocks';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { boot as bootApp, polyfillDom } from '../../components/testKit';
import { api } from '../../lib/api';
import { demoP2State } from '../../mocks/demoSeed';
import type { MockState } from '../../mocks/ipcMock';
import { subtaskItems } from '../../lib/subtasks';
import { validateTagName } from './TagsSection';
import { liveTagIds, templatePreview, validateTemplateName } from './templateLogic';

beforeEach(() => {
  polyfillDom();
  window.localStorage.clear();
});
afterEach(() => {
  clearMocks();
  vi.restoreAllMocks();
  window.localStorage.clear();
});

let state: MockState;
const calls = (cmd: string) => state.calls.filter((c) => c.cmd === cmd).map((c) => c.args as Record<string, unknown>);

async function settings(s: MockState) {
  const user = userEvent.setup();
  state = s;
  bootApp(s);
  await user.click(await screen.findByRole('tab', { name: 'Settings' }));
  return user;
}
const section = (name: string) => within(screen.getByRole('region', { name }));

describe('tag rules', () => {
  const tags = [
    { id: 'a', name: 'Concept', color: '#000000', deleted: false, stamp: { at: '', by: '' } },
    { id: 'b', name: 'Old', color: '#000000', deleted: true, stamp: { at: '', by: '' } },
  ];
  it('needs a name of at most 40 characters that no other live tag has, ignoring case', () => {
    expect(validateTagName('', tags, null)).toBe('Enter a tag name.');
    expect(validateTagName('   ', tags, null)).toBe('Enter a tag name.');
    expect(validateTagName('x'.repeat(41), tags, null)).toMatch(/at most 40/);
    expect(validateTagName('x'.repeat(40), tags, null)).toBeNull();
    expect(validateTagName(' concept ', tags, null)).toMatch(/already exists/);
    expect(validateTagName('Concept', tags, 'a')).toBeNull();
    expect(validateTagName('Old', tags, null)).toBeNull(); // a deleted tag does not clash
  });
});

describe('Settings: tags', () => {
  it('lists the tags with their colour and how many tasks use each', async () => {
    await settings(demoP2State());
    const tags = section('Tags');
    const list = tags.getByRole('list', { name: 'Tags' });
    expect(within(list).getAllByRole('listitem')).toHaveLength(4);
    const concept = within(within(list).getByText('Concept').closest('li') as HTMLElement);
    expect(concept.getByText('#7c3aed')).toBeVisible();
    expect(concept.getByText('3 tasks')).toBeVisible();
    expect(within(within(list).getByText('Client call').closest('li') as HTMLElement).getByText('0 tasks')).toBeVisible();
  });

  it('adds a tag with a colour picked from the full spectrum, sent as lower-case #rrggbb, and returns focus to the button', async () => {
    const user = await settings(demoP2State());
    const tags = section('Tags');
    await user.click(tags.getByRole('button', { name: 'Add tag' }));
    const form = tags.getByRole('form', { name: 'New tag' });
    await user.type(within(form).getByRole('textbox', { name: 'Tag name' }), 'Print');
    await user.clear(within(form).getByRole('textbox', { name: 'Hex' }));
    await user.type(within(form).getByRole('textbox', { name: 'Hex' }), '#00AAFF');
    await user.click(within(form).getByRole('button', { name: 'Add tag' }));
    await waitFor(() => expect(calls('save_tag')).toHaveLength(1));
    expect(calls('save_tag')[0]).toEqual({ input: { id: null, name: 'Print', color: '#00aaff' } });
    expect(state.tags.find((t) => t.name === 'Print')?.color).toBe('#00aaff');
    expect(await tags.findByText('#00aaff')).toBeVisible();
    await waitFor(() => expect(tags.getByRole('button', { name: 'Add tag' })).toHaveFocus());
    expect(tags.queryByRole('form')).toBeNull();
  });

  it('refuses an empty or duplicate name before sending, and cancel sends nothing', async () => {
    const user = await settings(demoP2State());
    const tags = section('Tags');
    await user.click(tags.getByRole('button', { name: 'Add tag' }));
    const form = tags.getByRole('form', { name: 'New tag' });
    await user.click(within(form).getByRole('button', { name: 'Add tag' }));
    expect(await within(form).findByText('Enter a tag name.')).toBeVisible();
    await user.type(within(form).getByRole('textbox', { name: 'Tag name' }), 'revision');
    await user.click(within(form).getByRole('button', { name: 'Add tag' }));
    expect(await within(form).findByText(/A tag named “revision” already exists/)).toBeVisible();
    await user.click(within(form).getByRole('button', { name: 'Cancel' }));
    expect(calls('save_tag')).toEqual([]);
    expect(tags.queryByRole('form')).toBeNull();
  });

  it('shows the backend conflict beside the name, as text', async () => {
    const user = await settings(demoP2State());
    const tags = section('Tags');
    await user.click(tags.getByRole('button', { name: 'Add tag' }));
    const form = tags.getByRole('form', { name: 'New tag' });
    await user.type(within(form).getByRole('textbox', { name: 'Tag name' }), 'Fresh');
    vi.spyOn(api, 'saveTag').mockRejectedValueOnce({ code: 'conflict', message: 'a tag named "<b>Fresh</b>" already exists' });
    await user.click(within(form).getByRole('button', { name: 'Add tag' }));
    const alert = await within(form).findByText(/a tag named "<b>Fresh<\/b>" already exists/);
    expect(alert).toHaveAttribute('role', 'alert');
    expect(form.querySelector('b')).toBeNull();
    expect(within(form).getByRole('textbox', { name: 'Tag name' })).toHaveAttribute('aria-invalid', 'true');
    // Typing again clears the stale refusal.
    await user.type(within(form).getByRole('textbox', { name: 'Tag name' }), '2');
    expect(within(form).queryByText(/already exists/)).toBeNull();
  });

  it('shows a backend refusal of the colour beside the picker', async () => {
    const user = await settings(demoP2State());
    const tags = section('Tags');
    await user.click(tags.getByRole('button', { name: 'Add tag' }));
    const form = tags.getByRole('form', { name: 'New tag' });
    await user.type(within(form).getByRole('textbox', { name: 'Tag name' }), 'Fresh');
    vi.spyOn(api, 'saveTag').mockRejectedValueOnce({ code: 'validation', message: 'a color must look like #1a2b3c' });
    await user.click(within(form).getByRole('button', { name: 'Add tag' }));
    expect(await within(form).findByTestId('cp-error')).toHaveTextContent('a color must look like #1a2b3c');
    expect(within(form).getByRole('textbox', { name: 'Tag name' })).not.toHaveAttribute('aria-invalid');
  });

  it('renames and recolours a tag; tasks keep it because the id is unchanged', async () => {
    const user = await settings(demoP2State());
    const tags = section('Tags');
    await user.click(tags.getByRole('button', { name: 'Edit tag Concept' }));
    const form = tags.getByRole('form', { name: 'Edit tag Concept' });
    const name = within(form).getByRole('textbox', { name: 'Tag name' });
    await user.clear(name);
    await user.type(name, 'Concepts');
    await user.click(within(form).getByRole('radio', { name: 'Colour #db2777' }));
    await user.click(within(form).getByRole('button', { name: 'Save tag' }));
    await waitFor(() => expect(calls('save_tag')).toHaveLength(1));
    expect(calls('save_tag')[0]).toEqual({ input: { id: 'tag-concept', name: 'Concepts', color: '#db2777' } });
    expect(state.tags.find((t) => t.id === 'tag-concept')).toMatchObject({ name: 'Concepts', color: '#db2777' });
    expect(state.tasks.find((t) => t.id === 't-logo')?.tags).toContain('tag-concept');
    expect(await tags.findByText('Concepts')).toBeVisible();
    await waitFor(() => expect(tags.getByRole('button', { name: 'Edit tag Concepts' })).toHaveFocus());
  });

  it('warns when a tag colour is close to another tag, and saves anyway', async () => {
    const user = await settings(demoP2State());
    const tags = section('Tags');
    await user.click(tags.getByRole('button', { name: 'Add tag' }));
    const form = tags.getByRole('form', { name: 'New tag' });
    await user.type(within(form).getByRole('textbox', { name: 'Tag name' }), 'Twin');
    await user.clear(within(form).getByRole('textbox', { name: 'Hex' }));
    await user.type(within(form).getByRole('textbox', { name: 'Hex' }), '#7c3aee');
    expect(within(form).getByTestId('cp-warn-similar')).toHaveTextContent('Close to Concept (#7c3aed). Charts are harder to read when two tags look alike');
    await user.click(within(form).getByRole('button', { name: 'Add tag' }));
    await waitFor(() => expect(state.tags.find((t) => t.name === 'Twin')?.color).toBe('#7c3aee'));
  });

  it('asks before deleting, says what happens to the tasks, and deletes only after confirming', async () => {
    const user = await settings(demoP2State());
    const tags = section('Tags');
    await user.click(tags.getByRole('button', { name: 'Delete tag Concept' }));
    const dialog = await screen.findByRole('dialog', { name: 'Delete this tag?' });
    expect(dialog).toHaveTextContent('Tasks keep no tag of that name afterwards');
    expect(dialog).toHaveTextContent('3 tasks');
    await user.click(within(dialog).getByRole('button', { name: 'Keep it' }));
    expect(calls('delete_tag')).toEqual([]);
    await user.click(tags.getByRole('button', { name: 'Delete tag Concept' }));
    await user.click(within(await screen.findByRole('dialog', { name: 'Delete this tag?' })).getByRole('button', { name: 'Delete tag' }));
    await waitFor(() => expect(calls('delete_tag')).toEqual([{ id: 'tag-concept' }]));
    await waitFor(() => expect(tags.queryByText('Concept')).toBeNull());
    expect(tags.getAllByRole('listitem')).toHaveLength(3);
  });
});

describe('template rules', () => {
  it('needs a name of at most 120 characters', () => {
    expect(validateTemplateName('')).toBe('Enter a template name.');
    expect(validateTemplateName('x'.repeat(121))).toMatch(/at most 120/);
    expect(validateTemplateName('x'.repeat(120))).toBeNull();
  });

  it('previews the first line of text and the task-list items, and keeps only live tags', () => {
    const doc = {
      type: 'doc',
      content: [
        { type: 'paragraph', content: [{ type: 'text', text: 'Three directions.' }] },
        { type: 'taskList', content: [{ type: 'taskItem', attrs: { checked: true }, content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Moodboard' }] }] }] },
      ],
    };
    expect(templatePreview(doc)).toEqual({ firstLine: 'Three directions.', items: ['Moodboard'] });
    expect(templatePreview(null)).toEqual({ firstLine: '', items: [] });
    expect(liveTagIds({ tags: ['a', 'b', 'c'] }, new Set(['a', 'c']))).toEqual(['a', 'c']);
  });
});

describe('Settings: templates', () => {
  it('lists templates with project, tags and task-list items', async () => {
    await settings(demoP2State());
    const list = section('Templates').getByRole('list', { name: 'Templates' });
    const row = within(within(list).getByRole('heading', { name: 'Logo job' }).closest('li') as HTMLElement);
    expect(row.getByText('Brand refresh')).toBeVisible();
    expect(row.getByText('Concept')).toBeVisible();
    expect(row.getByText(/3 task-list items: Moodboard, Sketches, Final artwork/)).toBeVisible();
    expect(row.getByText('Three directions, one round of changes.')).toBeVisible();
  });

  it('creates a template from scratch with a project, tags and a task list, saved unticked', async () => {
    const user = await settings(demoP2State());
    const templates = section('Templates');
    await user.click(templates.getByRole('button', { name: 'New template' }));
    const form = templates.getByRole('form', { name: 'New template' });
    await user.click(within(form).getByRole('button', { name: 'Create template' }));
    expect(await within(form).findByText('Enter a template name.')).toBeVisible();
    expect(calls('save_template')).toEqual([]);
    await user.type(within(form).getByRole('textbox', { name: 'Template name' }), 'Packaging job');
    await user.selectOptions(within(form).getByRole('combobox', { name: 'Project' }), 'Packaging');
    await user.click(within(form).getByRole('checkbox', { name: 'Revision' }));
    await user.click(within(form).getByRole('checkbox', { name: 'Admin' }));
    await user.click(within(form).getByRole('button', { name: 'Task list' }));
    // The toolbar hands the caret to the editor a moment later; typing starts once it has it.
    await waitFor(() => expect(within(form).getByRole('textbox', { name: 'Template text' })).toHaveFocus());
    await user.keyboard('Dieline{Enter}Proof');
    await user.click(within(form).getByRole('button', { name: 'Create template' }));
    await waitFor(() => expect(calls('save_template')).toHaveLength(1));
    const input = (calls('save_template')[0] as { input: Record<string, unknown> }).input;
    expect(input).toMatchObject({ id: null, name: 'Packaging job', projectId: 'p-pack', tags: ['tag-revision', 'tag-admin'] });
    const saved = state.templates.find((t) => t.name === 'Packaging job');
    expect(subtaskItems(saved?.description).map((i) => [i.text, i.checked])).toEqual([['Dieline', false], ['Proof', false]]);
    expect(await templates.findByRole('heading', { name: 'Packaging job' })).toBeVisible();
    await waitFor(() => expect(templates.getByRole('button', { name: 'New template' })).toHaveFocus());
  });

  it('a ticked item in a template comes back unticked after saving', async () => {
    const s = demoP2State();
    const tpl = s.templates[0];
    const first = (tpl?.description as { content: { content: { attrs: { checked: boolean } }[] }[] }).content.find((n) => (n as { type?: string }).type === 'taskList');
    if (first) first.content[0]!.attrs.checked = true;
    const user = await settings(s);
    const templates = section('Templates');
    await user.click(templates.getByRole('button', { name: 'Edit template Logo job' }));
    await user.click(within(templates.getByRole('form', { name: 'Edit template Logo job' })).getByRole('button', { name: 'Save template' }));
    await waitFor(() => expect(calls('save_template')).toHaveLength(1));
    expect(subtaskItems(state.templates[0]?.description).every((i) => !i.checked)).toBe(true);
  });

  it('edits a template: rename, remove its project, change its tags', async () => {
    const user = await settings(demoP2State());
    const templates = section('Templates');
    await user.click(templates.getByRole('button', { name: 'Edit template Logo job' }));
    const form = templates.getByRole('form', { name: 'Edit template Logo job' });
    expect(within(form).getByRole('combobox', { name: 'Project' })).toHaveValue('p-brand');
    expect(within(form).getByRole('checkbox', { name: 'Concept' })).toBeChecked();
    const name = within(form).getByRole('textbox', { name: 'Template name' });
    await user.clear(name);
    await user.type(name, 'Logo job v2');
    await user.selectOptions(within(form).getByRole('combobox', { name: 'Project' }), 'No project (choose when used)');
    await user.click(within(form).getByRole('checkbox', { name: 'Concept' }));
    await user.click(within(form).getByRole('checkbox', { name: 'Revision' }));
    await user.click(within(form).getByRole('button', { name: 'Save template' }));
    await waitFor(() => expect(calls('save_template')).toHaveLength(1));
    expect((calls('save_template')[0] as { input: Record<string, unknown> }).input).toMatchObject({ id: 'tpl-logo', name: 'Logo job v2', projectId: null, tags: ['tag-revision'] });
    expect(state.templates).toHaveLength(1);
    expect(await templates.findByRole('heading', { name: 'Logo job v2' })).toBeVisible();
    // The text, with its task list, was kept.
    expect(subtaskItems(state.templates[0]?.description).map((i) => i.text)).toEqual(['Moodboard', 'Sketches', 'Final artwork']);
  });

  it('shows a refusal from the backend as text and keeps the form open', async () => {
    const user = await settings(demoP2State());
    const templates = section('Templates');
    await user.click(templates.getByRole('button', { name: 'New template' }));
    const form = templates.getByRole('form', { name: 'New template' });
    await user.type(within(form).getByRole('textbox', { name: 'Template name' }), 'Odd');
    vi.spyOn(api, 'saveTemplate').mockRejectedValueOnce({ code: 'validation', message: 'description is too large <u>x</u>' });
    await user.click(within(form).getByRole('button', { name: 'Create template' }));
    expect(await within(form).findByText('description is too large <u>x</u>')).toHaveAttribute('role', 'alert');
    expect(form.querySelector('u')).toBeNull();
    expect(within(form).getByRole('textbox', { name: 'Template name' })).toHaveValue('Odd');
  });

  it('deletes only after confirming, and says tasks already made are unchanged', async () => {
    const user = await settings(demoP2State());
    const templates = section('Templates');
    await user.click(templates.getByRole('button', { name: 'Delete template Logo job' }));
    const dialog = await screen.findByRole('dialog', { name: 'Delete this template?' });
    expect(dialog).toHaveTextContent('Tasks already made from it are not changed');
    await user.click(within(dialog).getByRole('button', { name: 'Keep it' }));
    expect(calls('delete_template')).toEqual([]);
    await user.click(templates.getByRole('button', { name: 'Delete template Logo job' }));
    await user.click(within(await screen.findByRole('dialog', { name: 'Delete this template?' })).getByRole('button', { name: 'Delete template' }));
    await waitFor(() => expect(calls('delete_template')).toEqual([{ id: 'tpl-logo' }]));
    expect(await templates.findByText('No templates yet.')).toBeVisible();
  });
});
