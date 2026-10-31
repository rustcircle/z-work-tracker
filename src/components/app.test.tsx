import { clearMocks } from '@tauri-apps/api/mocks';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { MASK } from '../lib/billing';
import { demoState } from '../mocks/demoSeed';
import { emptyState, type MockState } from '../mocks/ipcMock';
import { boot as bootApp, polyfillDom } from './testKit';

beforeEach(polyfillDom);
afterEach(() => clearMocks());

let state: MockState;
function boot(s: MockState) {
  state = s;
  return bootApp(s);
}
const card = (name: string) => within(screen.getByRole('article', { name }));
const live = (c: ReturnType<typeof card>) =>
  (['Start', 'Pause', 'Resume', 'Stop'] as const).filter((n) => !(c.getByRole('button', { name: n }) as HTMLButtonElement).disabled);

function emptyWithProject(): MockState {
  const s = emptyState('2026-03-12T15:20:00Z');
  s.projects.push({ id: 'p1', name: 'Brand refresh', color: '#2563eb', archived: false, billable: true, budgetHours: null, clientZone: null, createdAt: '2026-01-01T00:00:00Z', hasTasks: false });
  return s;
}

describe('new task form', () => {
  it('keeps Start disabled, with visible text, until every field the cold launch needs is valid', async () => {
    const user = userEvent.setup();
    boot(emptyWithProject());
    await user.click(await screen.findByRole('button', { name: 'New task' }));
    const start = screen.getByRole('button', { name: 'Start' });
    expect(start).toBeDisabled();
    // The starter tags exist, so the data-driven list ends with the tag requirement.
    expect(screen.getByText('To start, enter a task name, a project, a description and at least one tag.')).toBeVisible();

    await user.type(screen.getByRole('textbox', { name: 'Task name' }), 'Draft logo');
    expect(start).toBeDisabled();
    expect(screen.getByText('To start, enter a project, a description and at least one tag.')).toBeVisible();

    await user.selectOptions(screen.getByRole('combobox', { name: 'Project' }), 'p1');
    expect(start).toBeDisabled();
    expect(screen.getByText('To start, enter a description and at least one tag.')).toBeVisible();

    await user.type(screen.getByRole('textbox', { name: 'Description' }), 'Three directions');
    expect(start).toBeDisabled();
    expect(screen.getByText('To start, enter at least one tag.')).toBeVisible();

    await user.click(screen.getByRole('checkbox', { name: 'Concept' }));
    expect(start).toBeEnabled();
    expect(screen.queryByText(/To start, enter/)).toBeNull();
  });

  it('shows field errors when saving a draft without them, and sends nothing', async () => {
    const user = userEvent.setup();
    boot(emptyWithProject());
    await user.click(await screen.findByRole('button', { name: 'New task' }));
    await user.click(screen.getByRole('button', { name: 'Save draft' }));
    expect(await screen.findByText('Enter a task name.')).toBeVisible();
    expect(screen.getByText('Choose a project.')).toBeVisible();
    expect(state.calls.some((c) => c.cmd === 'create_task')).toBe(false);
  });

  it('saves a draft with a description and starts a task in one step', async () => {
    const user = userEvent.setup();
    boot(emptyWithProject());
    await user.click(await screen.findByRole('button', { name: 'New task' }));
    await user.type(screen.getByRole('textbox', { name: 'Task name' }), 'Logo');
    await user.selectOptions(screen.getByRole('combobox', { name: 'Project' }), 'p1');
    await user.click(screen.getByRole('button', { name: 'Numbered list' }));
    await user.type(screen.getByRole('textbox', { name: 'Description' }), 'Moodboard{Enter}Sketches');
    // A cold start needs a tag as soon as any tag exists.
    expect(screen.getByRole('button', { name: 'Start' })).toBeDisabled();
    expect(screen.getByText('To start, enter at least one tag.')).toBeVisible();
    await user.click(screen.getByRole('checkbox', { name: 'Concept' }));
    await user.click(screen.getByRole('button', { name: 'Start' }));
    await waitFor(() => expect(state.tasks[0]?.state).toBe('running'));
    expect(state.tasks[0]?.tags).toEqual(['tag-concept']);
    const json = JSON.stringify(state.tasks[0]?.description);
    expect(json).toContain('orderedList');
    expect(json).toContain('Sketches');
    expect(state.calls.map((c) => c.cmd).filter((c) => c === 'create_task' || c === 'start_task')).toEqual(['create_task', 'start_task']);
  });
});

describe('task controls', () => {
  it('enables only the valid buttons for each state', async () => {
    boot(demoState());
    await screen.findByRole('article', { name: 'Logo concepts' });
    expect(live(card('Social templates'))).toEqual(['Start']); // draft
    expect(live(card('Logo concepts'))).toEqual(['Pause', 'Stop']); // running
    expect(live(card('Brand guidelines'))).toEqual(['Resume', 'Stop']); // paused
    expect(live(card('Homepage layout'))).toEqual([]); // stopped
  });

  it('says why a task was paused', async () => {
    const s = demoState();
    const guide = s.tasks.find((t) => t.id === 't-guide');
    if (guide) guide.pauseReason = { kind: 'autoPaused', byTaskId: 't-logo' };
    boot(s);
    expect(await screen.findByText('Auto-paused because "Logo concepts" was started.')).toBeVisible();
  });

  it('a task running on another device can only be stopped, and names the device', async () => {
    const s = demoState();
    const logo = s.tasks.find((t) => t.id === 't-logo');
    if (logo) logo.runningElsewhere = 'Office PC';
    boot(s);
    await screen.findByText('Office PC');
    expect(live(card('Logo concepts'))).toEqual(['Stop']);
  });

  it('shows the auto-pause toast when starting a task pauses another', async () => {
    const user = userEvent.setup();
    boot(demoState());
    await user.click(await within(await screen.findByRole('article', { name: 'Social templates' })).findByRole('button', { name: 'Start' }));
    expect(await screen.findByText(/Paused "Logo concepts" because you started "Social templates"/)).toBeVisible();
    expect(live(card('Logo concepts'))).toEqual(['Resume', 'Stop']);
  });
});

describe('hide earnings', () => {
  it('masks every amount, and shows them again when switched off', async () => {
    const user = userEvent.setup();
    boot(demoState());
    const summary = await screen.findByLabelText('Period totals');
    expect(summary).toHaveTextContent('$315.00');
    const toggle = screen.getByRole('button', { name: 'Hide earnings' });
    expect(toggle).toHaveAttribute('aria-pressed', 'false');
    await user.click(toggle);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Hide earnings' })).toHaveAttribute('aria-pressed', 'true'));
    expect(state.hideEarnings).toBe(true);
    expect(summary).toHaveTextContent(MASK);
    expect(document.body.textContent).not.toMatch(/[$€]\d/);
    expect(screen.getAllByText(new RegExp(MASK)).length).toBeGreaterThan(3);
    await user.click(screen.getByRole('button', { name: 'Hide earnings' }));
    await waitFor(() => expect(screen.getByLabelText('Period totals')).toHaveTextContent('$315.00'));
  });

  it('starts masked when the preference is already on', async () => {
    const s = demoState();
    s.hideEarnings = true;
    boot(s);
    await screen.findByLabelText('Period totals');
    expect(document.body.textContent).not.toMatch(/[$€]\d/);
  });
});

describe('export', () => {
  it('exports without earnings and without sheets that hold prices', async () => {
    const user = userEvent.setup();
    boot(demoState());
    await user.click(await screen.findByRole('button', { name: 'Export' }));
    const dialog = screen.getByRole('dialog', { name: 'Export' });
    const include = within(dialog).getByRole('switch', { name: 'Include earnings' });
    expect(include).toBeChecked();
    await user.click(include);
    expect(include).not.toBeChecked();
    await user.click(within(dialog).getByRole('button', { name: 'Export Excel' }));
    expect(await within(dialog).findByTestId('export-result')).toHaveTextContent('/mock/export.xlsx');
    const req = state.exports[0]?.request;
    expect(req?.includeEarnings).toBe(false);
    expect(req?.analytics.some((a) => a.containsPrices)).toBe(false);
    expect(req?.dayZone).toBe('Europe/Lisbon');
    expect(req?.myZone).toBe('Europe/Lisbon');
    // Morning shift 09:00-13:00 Lisbon: the 09:00-11:20 segment sits fully inside it.
    expect(Object.values(req?.segmentShifts ?? {})).toContain('Morning 2:20:00');
  });

  it('includes earnings and the client zone by default, and exports CSV', async () => {
    const user = userEvent.setup();
    boot(demoState());
    await user.click(await screen.findByRole('button', { name: 'Export' }));
    const dialog = screen.getByRole('dialog', { name: 'Export' });
    await user.click(within(dialog).getByRole('radio', { name: 'CSV (.csv)' }));
    await user.click(within(dialog).getByRole('button', { name: 'Export CSV' }));
    await within(dialog).findByTestId('export-result');
    expect(state.exports[0]).toMatchObject({ kind: 'csv', request: { includeEarnings: true, clientZone: 'America/New_York', analytics: [] } });
  });
});
