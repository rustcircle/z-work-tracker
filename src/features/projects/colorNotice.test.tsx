// The visible half of the colour rule: an exact clash is replaced by the backend and the user is told, with a
// way to choose again. The rule itself is tested against the mock in mocks/gapfill.test.ts.
import { clearMocks } from '@tauri-apps/api/mocks';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { boot, polyfillDom } from '../../components/testKit';
import { demoState } from '../../mocks/demoSeed';
import { fullProject } from '../../mocks/factories';
import { emptyState, type MockState } from '../../mocks/ipcMock';

beforeEach(() => {
  polyfillDom();
  window.localStorage.clear();
});
afterEach(() => {
  clearMocks();
  window.localStorage.clear();
});

const BRAND = '#2563eb';

async function newProject(s: MockState, name: string, hex: string) {
  const user = userEvent.setup();
  boot(s);
  await user.click(await screen.findByRole('tab', { name: 'Projects' }));
  await user.click(screen.getByRole('button', { name: 'New project' }));
  const form = screen.getByRole('form', { name: 'New project' });
  await user.type(within(form).getByRole('textbox', { name: 'Project name' }), name);
  const field = within(form).getByRole('textbox', { name: 'Hex' });
  await user.clear(field);
  await user.type(field, hex);
  await user.click(within(form).getByRole('button', { name: 'Create project' }));
  return user;
}

describe('replaced project colour', () => {
  it('is never silent: the notice names the project, prints both colours and offers Choose again', async () => {
    const s = demoState();
    await newProject(s, 'Retail', BRAND);
    const notice = await screen.findByTestId('color-notice');
    const saved = s.projects.find((p) => p.name === 'Retail');
    expect(saved?.color).not.toBe(BRAND);
    expect(notice).toHaveTextContent('Retail was saved with a different colour');
    expect(notice).toHaveTextContent(BRAND);
    expect(notice).toHaveTextContent(saved?.color ?? 'missing');
    expect(within(notice).getByRole('button', { name: /Choose again/ })).toBeVisible();
  });

  it('Choose again opens that project with the cursor in the colour choice, and a new colour clears the notice', async () => {
    const s = demoState();
    const user = await newProject(s, 'Retail', BRAND);
    await user.click(await within(await screen.findByTestId('color-notice')).findByRole('button', { name: /Choose again/ }));
    const form = await screen.findByRole('form', { name: /Retail/ });
    await waitFor(() => expect(form.contains(document.activeElement)).toBe(true));
    expect(document.activeElement).not.toBe(within(form).getByRole('textbox', { name: 'Project name' }));
    const field = within(form).getByRole('textbox', { name: 'Hex' });
    await user.clear(field);
    await user.type(field, '#123abc');
    await user.click(within(form).getByRole('button', { name: /Save project/ }));
    await waitFor(() => expect(s.projects.find((p) => p.name === 'Retail')?.color).toBe('#123abc'));
    await waitFor(() => expect(screen.queryByTestId('color-notice')).toBeNull());
  });

  it('can be accepted with the close button, which removes the notice only', async () => {
    const s = demoState();
    const user = await newProject(s, 'Retail', BRAND);
    await user.click(await screen.findByRole('button', { name: 'Keep the new colour for Retail' }));
    expect(screen.queryByTestId('color-notice')).toBeNull();
    expect(s.projects.find((p) => p.name === 'Retail')).toBeDefined();
  });

  it('does not appear for a colour nobody else uses, or one only similar to another (that keeps its warning)', async () => {
    const s = demoState();
    await newProject(s, 'Retail', '#2564eb');
    await waitFor(() => expect(s.projects.find((p) => p.name === 'Retail')?.color).toBe('#2564eb'));
    expect(screen.queryByTestId('color-notice')).toBeNull();
  });

  it('ignores an archived project: the colour is kept as typed', async () => {
    const s = emptyState();
    s.projects.push({ ...fullProject({ id: 'old', name: 'Old', color: BRAND }), archived: true });
    await newProject(s, 'New', BRAND);
    await waitFor(() => expect(s.projects.find((p) => p.name === 'New')?.color).toBe(BRAND));
    expect(screen.queryByTestId('color-notice')).toBeNull();
  });
});

describe('replaced tag colour', () => {
  it('shows the same notice in Settings and Choose again opens that tag at its colour', async () => {
    const s = emptyState();
    const user = userEvent.setup();
    boot(s);
    await user.click(await screen.findByRole('tab', { name: 'Settings' }));
    await user.click(await screen.findByRole('button', { name: 'Add tag' }));
    const form = screen.getByRole('form', { name: 'New tag' });
    await user.type(within(form).getByRole('textbox', { name: 'Tag name' }), 'Review');
    const hex = within(form).getByRole('textbox', { name: 'Hex' });
    await user.clear(hex);
    await user.type(hex, '#7c3aed'); // the starter Concept tag's colour
    await user.click(within(form).getByRole('button', { name: 'Add tag' }));
    const notice = await screen.findByTestId('color-notice');
    expect(notice).toHaveTextContent('Review was saved with a different colour');
    expect(notice).toHaveTextContent('#7c3aed');
    const got = s.tags.find((t) => t.name === 'Review')?.color;
    expect(got).not.toBe('#7c3aed');
    await user.click(within(notice).getByRole('button', { name: /Choose again/ }));
    const edit = await screen.findByRole('form', { name: 'Edit tag Review' });
    await waitFor(() => expect(edit.contains(document.activeElement)).toBe(true));
    expect(document.activeElement).not.toBe(within(edit).getByRole('textbox', { name: 'Tag name' }));
  });
});
