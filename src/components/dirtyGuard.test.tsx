// A form on a tab dies with the tab, because only the open tab is mounted. Leaving it with unsaved changes asks first.
import { clearMocks } from '@tauri-apps/api/mocks';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { demoP2State, demoState } from '../mocks/demoSeed';
import type { MockState } from '../mocks/ipcMock';
import { boot, polyfillDom } from './testKit';

beforeEach(polyfillDom);
afterEach(() => clearMocks());

type User = ReturnType<typeof userEvent.setup>;

const ASK = 'Leave without saving?';
const section = (name: string) => within(screen.getByRole('region', { name }));
const asking = () => screen.queryByRole('dialog', { name: ASK });
const selected = (tab: string) => expect(screen.getByRole('tab', { name: tab })).toHaveAttribute('aria-selected', 'true');

async function onSettings(s: MockState = demoState()): Promise<User> {
  const user = userEvent.setup();
  boot(s);
  await user.click(await screen.findByRole('tab', { name: 'Settings' }));
  await screen.findByRole('region', { name: 'Templates' });
  return user;
}

/** A template being written: the form is open and a name is typed. */
async function typingATemplate(user: User): Promise<void> {
  await user.click(section('Templates').getByRole('button', { name: 'New template' }));
  await user.type(section('Templates').getByRole('textbox', { name: 'Template name' }), 'Packaging job');
}

describe('clicking a tab with a form that has unsaved changes', () => {
  it('R10: a template being written is kept when the user chooses to keep editing', async () => {
    const user = await onSettings();
    await typingATemplate(user);
    await user.click(screen.getByRole('tab', { name: 'Timeline' }));
    const dialog = within(await screen.findByRole('dialog', { name: ASK }));
    expect(dialog.getByText(/changes that are not saved/)).toBeVisible();
    await user.click(dialog.getByRole('button', { name: 'Keep editing' }));
    await waitFor(() => expect(asking()).toBeNull());
    selected('Settings');
    expect(section('Templates').getByRole('textbox', { name: 'Template name' })).toHaveValue('Packaging job');
    // Esc says the same as Keep editing.
    await user.click(screen.getByRole('tab', { name: 'Billing' }));
    await screen.findByRole('dialog', { name: ASK });
    await user.keyboard('{Escape}');
    await waitFor(() => expect(asking()).toBeNull());
    selected('Settings');
    expect(section('Templates').getByRole('textbox', { name: 'Template name' })).toHaveValue('Packaging job');
  });

  it('R10: it leaves for the tab clicked when the user agrees, and the form is gone on the way back', async () => {
    const user = await onSettings();
    await typingATemplate(user);
    await user.click(screen.getByRole('tab', { name: 'Analysis' }));
    await user.click(within(await screen.findByRole('dialog', { name: ASK })).getByRole('button', { name: 'Leave and discard' }));
    await screen.findByRole('region', { name: 'Analysis' });
    selected('Analysis');
    expect(asking()).toBeNull();
    // Nothing is held any more: the next tab change goes straight through.
    await user.click(screen.getByRole('tab', { name: 'Settings' }));
    await screen.findByRole('region', { name: 'Templates' });
    expect(screen.queryByRole('form', { name: 'New template' })).toBeNull();
    await user.click(screen.getByRole('tab', { name: 'Timeline' }));
    expect(asking()).toBeNull();
    selected('Timeline');
  });

  it('R10: a tag being added asks too', async () => {
    const user = await onSettings();
    await user.click(section('Tags').getByRole('button', { name: 'Add tag' }));
    await user.type(section('Tags').getByRole('textbox', { name: 'Tag name' }), 'Research');
    await user.click(screen.getByRole('tab', { name: 'Projects' }));
    await user.click(within(await screen.findByRole('dialog', { name: ASK })).getByRole('button', { name: 'Keep editing' }));
    expect(section('Tags').getByRole('textbox', { name: 'Tag name' })).toHaveValue('Research');
    selected('Settings');
  });

  it('R10: a tag being renamed asks, and one left as it was does not', async () => {
    const user = await onSettings();
    const tags = section('Tags');
    await user.click(tags.getAllByRole('button', { name: /^Edit/ })[0] as HTMLElement);
    // Opened and not touched: leaving costs nothing.
    await user.click(screen.getByRole('tab', { name: 'Projects' }));
    expect(asking()).toBeNull();
    selected('Projects');
    await user.click(screen.getByRole('tab', { name: 'Settings' }));
    await user.click(section('Tags').getAllByRole('button', { name: /^Edit/ })[0] as HTMLElement);
    const name = section('Tags').getByRole('textbox', { name: 'Tag name' });
    await user.type(name, 'x');
    await user.click(screen.getByRole('tab', { name: 'Projects' }));
    await screen.findByRole('dialog', { name: ASK });
    selected('Settings');
  });

  it('R10: a shift being written asks too', async () => {
    const user = await onSettings();
    await user.click(section('Shifts').getByRole('button', { name: 'New shift' }));
    await user.type(section('Shifts').getByRole('textbox', { name: 'Shift name' }), 'Early');
    await user.click(screen.getByRole('tab', { name: 'Billing' }));
    await user.click(within(await screen.findByRole('dialog', { name: ASK })).getByRole('button', { name: 'Keep editing' }));
    expect(section('Shifts').getByRole('textbox', { name: 'Shift name' })).toHaveValue('Early');
    selected('Settings');
  });

  it('R10: a shift changed from a preset asks, and a preset left as it came does not', async () => {
    const user = await onSettings();
    await user.click(section('Shifts').getByRole('button', { name: 'Add Morning preset' }));
    await user.click(screen.getByRole('tab', { name: 'Billing' }));
    expect(asking()).toBeNull();
    selected('Billing');
    await user.click(screen.getByRole('tab', { name: 'Settings' }));
    await user.click(section('Shifts').getByRole('button', { name: 'Add Morning preset' }));
    // A weekday toggled is a change as well, not only typed text.
    await user.click(within(section('Shifts').getByRole('form')).getByRole('button', { name: /^Mon/ }));
    await user.click(screen.getByRole('tab', { name: 'Billing' }));
    await screen.findByRole('dialog', { name: ASK });
  });

  it('R10: nothing is asked when nothing was typed, when it was typed and erased again, or once it is saved', async () => {
    const user = await onSettings();
    await user.click(section('Templates').getByRole('button', { name: 'New template' }));
    await user.click(screen.getByRole('tab', { name: 'Timeline' }));
    expect(asking()).toBeNull();
    selected('Timeline');

    await user.click(screen.getByRole('tab', { name: 'Settings' }));
    await user.click(section('Templates').getByRole('button', { name: 'New template' }));
    const name = section('Templates').getByRole('textbox', { name: 'Template name' });
    await user.type(name, 'abc');
    await user.clear(name);
    await user.click(screen.getByRole('tab', { name: 'Timeline' }));
    expect(asking()).toBeNull();
    selected('Timeline');

    await user.click(screen.getByRole('tab', { name: 'Settings' }));
    await user.click(section('Templates').getByRole('button', { name: 'New template' }));
    await user.type(section('Templates').getByRole('textbox', { name: 'Template name' }), 'Saved one');
    await user.click(section('Templates').getByRole('button', { name: 'Create template' }));
    await screen.findByRole('heading', { name: 'Saved one' });
    await user.click(screen.getByRole('tab', { name: 'Timeline' }));
    expect(asking()).toBeNull();
    selected('Timeline');
  });

  it('R10: a template opened for editing, with its text and task list, asks nothing until something is changed', async () => {
    const user = userEvent.setup();
    boot(demoP2State());
    await screen.findByRole('region', { name: 'Timeline' });
    // The time-away dialog of this seed is answered later.
    await user.keyboard('{Escape}');
    await user.click(screen.getByRole('tab', { name: 'Settings' }));
    const templates = await screen.findByRole('region', { name: 'Templates' });
    await user.click(within(templates).getByRole('button', { name: /^Edit\s*template Logo job/ }));
    const form = await within(templates).findByRole('form', { name: 'Edit template Logo job' });
    expect(within(form).getByRole('textbox', { name: 'Template text' })).toHaveTextContent('Three directions');
    await user.click(screen.getByRole('tab', { name: 'Timeline' }));
    expect(asking()).toBeNull();
    selected('Timeline');
    // Opened again and given a new name, it asks.
    await user.click(screen.getByRole('tab', { name: 'Settings' }));
    await user.click(within(screen.getByRole('region', { name: 'Templates' })).getByRole('button', { name: /^Edit\s*template Logo job/ }));
    await user.type(within(screen.getByRole('region', { name: 'Templates' })).getByRole('textbox', { name: 'Template name' }), ' 2');
    await user.click(screen.getByRole('tab', { name: 'Timeline' }));
    await screen.findByRole('dialog', { name: ASK });
    selected('Settings');
  });

  it('R10: a form that is cancelled asks nothing afterwards', async () => {
    const user = await onSettings();
    await typingATemplate(user);
    await user.click(section('Templates').getByRole('button', { name: 'Cancel' }));
    await user.click(screen.getByRole('tab', { name: 'Timeline' }));
    expect(asking()).toBeNull();
    selected('Timeline');
  });

  it('R10: the tab already shown can be clicked without being asked', async () => {
    const user = await onSettings();
    await typingATemplate(user);
    await user.click(screen.getByRole('tab', { name: 'Settings' }));
    expect(asking()).toBeNull();
    expect(section('Templates').getByRole('textbox', { name: 'Template name' })).toHaveValue('Packaging job');
  });
});

describe('moving between tabs by keyboard with a form that has unsaved changes', () => {
  it('R10: the arrow keys ask too, and focus stays on the tab until the user agrees', async () => {
    const user = await onSettings();
    await typingATemplate(user);
    screen.getByRole('tab', { name: 'Settings' }).focus();
    await user.keyboard('{ArrowRight}');
    await user.click(within(await screen.findByRole('dialog', { name: ASK })).getByRole('button', { name: 'Keep editing' }));
    selected('Settings');
    expect(screen.getByRole('tab', { name: 'Settings' })).toHaveFocus();
    await user.keyboard('{ArrowRight}');
    await user.click(within(await screen.findByRole('dialog', { name: ASK })).getByRole('button', { name: 'Leave and discard' }));
    // The tab it wrapped round to is the one shown, and it has the keyboard.
    selected('Timeline');
    await waitFor(() => expect(screen.getByRole('tab', { name: 'Timeline' })).toHaveFocus());
  });

  it('R10: the arrow keys move straight on when there is nothing to lose', async () => {
    const user = await onSettings();
    screen.getByRole('tab', { name: 'Settings' }).focus();
    await user.keyboard('{ArrowLeft}');
    expect(asking()).toBeNull();
    selected('Projects');
    expect(screen.getByRole('tab', { name: 'Projects' })).toHaveFocus();
  });
});

describe('other ways of changing the tab with a form that has unsaved changes', () => {
  it('R10: "Set a rate" in the ticker asks first, and takes the user to the project when they agree', async () => {
    const s = demoState();
    s.rates = s.rates.filter((r) => r.projectId !== 'p-brand');
    const user = await onSettings(s);
    await typingATemplate(user);
    const ticker = (await screen.findAllByRole('button', { name: 'Set a rate' })).find((b) => b.closest('.ticker'));
    if (!ticker) throw new Error('the ticker has no Set a rate button');
    await user.click(ticker);
    await user.click(within(await screen.findByRole('dialog', { name: ASK })).getByRole('button', { name: 'Keep editing' }));
    selected('Settings');
    expect(screen.queryByRole('form', { name: 'Edit project Brand refresh' })).toBeNull();
    await user.click(ticker);
    await user.click(within(await screen.findByRole('dialog', { name: ASK })).getByRole('button', { name: 'Leave and discard' }));
    expect(await screen.findByRole('form', { name: 'Edit project Brand refresh' })).toBeVisible();
    selected('Projects');
  });
});
