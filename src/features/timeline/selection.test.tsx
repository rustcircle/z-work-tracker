// Selecting Timeline entries for export, through the real app on the IPC mock: pointer, keyboard, ranges across
// days, a task-day with several rows, the bar and its total, the live region, filters, and the export request.
import { clearMocks } from '@tauri-apps/api/mocks';
import { act, cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { boot as bootApp, polyfillDom } from '../../components/testKit';
import { demoState } from '../../mocks/demoSeed';
import type { MockState } from '../../mocks/ipcMock';

let state: MockState;
const boot = (s: MockState) => {
  state = s;
  return bootApp(s);
};

beforeEach(() => polyfillDom());
afterEach(() => {
  cleanup();
  clearMocks();
});

const rowsOf = (day: string): HTMLElement[] => within(screen.getByRole('article', { name: day })).getAllByTestId('entry');
const selectedRows = (): HTMLElement[] => screen.getAllByTestId('entry').filter((r) => r.getAttribute('aria-selected') === 'true');
const bar = () => screen.queryByTestId('selection-bar');
const nameOf = (row: HTMLElement): string => within(row).getByRole('button', { name: /^(?!Edit)/ }).textContent ?? '';
const TODAY = 'Thu 12 Mar 2026';
const YESTERDAY = 'Wed 11 Mar 2026';

async function open(s: MockState = demoState()) {
  const user = userEvent.setup();
  boot(s);
  await screen.findByRole('region', { name: 'Timeline' });
  await screen.findAllByTestId('entry');
  return user;
}

const ctrl = async (user: ReturnType<typeof userEvent.setup>, el: HTMLElement) => {
  await user.keyboard('{Control>}');
  await user.click(el);
  await user.keyboard('{/Control}');
};
const shift = async (user: ReturnType<typeof userEvent.setup>, el: HTMLElement) => {
  await user.keyboard('{Shift>}');
  await user.click(el);
  await user.keyboard('{/Shift}');
};

describe('pointer selection', () => {
  it('a click selects a task-day, without opening, editing or timing anything', async () => {
    const user = await open();
    const callsBefore = state.calls.length;
    const row = rowsOf(YESTERDAY)[0] as HTMLElement;
    await user.click(row);
    expect(selectedRows().length).toBeGreaterThanOrEqual(1);
    expect(row).toHaveAttribute('aria-selected', 'true');
    expect(within(bar() as HTMLElement).getByTestId('selection-count')).toHaveTextContent('1 task selected');
    // No editor opened, nothing started or stopped, nothing sent to the backend.
    expect(screen.queryByRole('textbox', { name: 'Task name' })).toBeNull();
    expect(state.calls.slice(callsBefore).map((c) => c.cmd)).toEqual([]);
    // The state is a shape, not only a colour: a check mark sits in the row.
    expect(within(row).getByTestId('sel-mark-on')).toBeInTheDocument();
  });

  it('the task name opens the task on a plain click, but is part of the row when Ctrl, Cmd or Shift is held', async () => {
    const user = await open();
    const row = rowsOf(TODAY)[0] as HTMLElement;
    const name = within(row).getByRole('button', { name: nameOf(row) });
    const card = () => screen.getAllByRole('article').find((a) => a.getAttribute('aria-label') === nameOf(row) || within(a).queryByRole('heading', { name: nameOf(row) }) !== null);
    // Plain click: opens the task (the card takes focus) and selects nothing.
    await user.click(name);
    expect(row).toHaveAttribute('aria-selected', 'false');
    expect(card()).toHaveFocus();
    (document.activeElement as HTMLElement).blur();
    // Ctrl: toggles the row and opens nothing.
    await user.keyboard('{Control>}');
    await user.click(name);
    await user.keyboard('{/Control}');
    expect(row).toHaveAttribute('aria-selected', 'true');
    expect(card()).not.toHaveFocus();
    // Cmd does the same.
    await user.keyboard('{Meta>}');
    await user.click(name);
    await user.keyboard('{/Meta}');
    expect(row).toHaveAttribute('aria-selected', 'false');
    expect(card()).not.toHaveFocus();
    // Shift from another row extends a range through it, and opens nothing either.
    await user.click(rowsOf(YESTERDAY)[0] as HTMLElement);
    await user.keyboard('{Shift>}');
    await user.click(name);
    await user.keyboard('{/Shift}');
    expect(row).toHaveAttribute('aria-selected', 'true');
    expect(selectedRows().length).toBeGreaterThanOrEqual(2);
    expect(card()).not.toHaveFocus();
  });

  it('a plain click on another row replaces the selection', async () => {
    const user = await open();
    const rows = rowsOf(YESTERDAY);
    await user.click(rows[0] as HTMLElement);
    const other = rowsOf(TODAY).find((r) => nameOf(r) !== nameOf(rows[0] as HTMLElement)) as HTMLElement;
    await user.click(other);
    expect(other).toHaveAttribute('aria-selected', 'true');
    expect(rows[0]).toHaveAttribute('aria-selected', 'false');
  });

  it('Ctrl+click adds and removes, also across days', async () => {
    const user = await open();
    const a = rowsOf(YESTERDAY)[0] as HTMLElement;
    const b = rowsOf('Tue 10 Mar 2026')[0] as HTMLElement;
    await user.click(a);
    await ctrl(user, b);
    expect(within(bar() as HTMLElement).getByTestId('selection-count')).toHaveTextContent('2 tasks selected');
    await ctrl(user, a);
    expect(within(bar() as HTMLElement).getByTestId('selection-count')).toHaveTextContent('1 task selected');
    expect(b).toHaveAttribute('aria-selected', 'true');
  });

  it('Shift+click selects the contiguous range in the order on screen, across days', async () => {
    const user = await open();
    const todayRows = rowsOf(TODAY);
    const last = rowsOf('Tue 10 Mar 2026').at(-1) as HTMLElement;
    await user.click(todayRows[0] as HTMLElement);
    await shift(user, last);
    const taskDays = new Set(screen.getAllByTestId('entry').filter((r) => r.getAttribute('aria-selected') === 'true').map((r) => r.getAttribute('data-sel-key')));
    const expected = new Set(
      screen
        .getAllByTestId('entry')
        .map((r) => r.getAttribute('data-sel-key'))
        .filter((k): k is string => k !== null)
        .slice(0, screen.getAllByTestId('entry').findIndex((r) => r === last) + 1),
    );
    expect(taskDays).toEqual(expected);
    expect(taskDays.size).toBeGreaterThan(2);
  });

  it('selecting one row of a task-day selects every row of it, and says so', async () => {
    const user = await open();
    const today = rowsOf(TODAY);
    const logoRows = today.filter((r) => nameOf(r) === 'Logo concepts');
    expect(logoRows.length).toBeGreaterThan(1);
    expect(within(logoRows[0] as HTMLElement).getByTestId('entry-siblings')).toHaveTextContent(`One of ${logoRows.length} rows`);
    await user.click(logoRows[0] as HTMLElement);
    for (const r of logoRows) expect(r).toHaveAttribute('aria-selected', 'true');
    expect(within(bar() as HTMLElement).getByTestId('selection-count')).toHaveTextContent('1 task selected');
  });

  it('the controls inside a row keep working and do not select', async () => {
    const user = await open();
    const row = rowsOf(TODAY)[0] as HTMLElement;
    await user.click(within(row).getByRole('button', { name: /^Edit task/ }));
    expect(selectedRows()).toHaveLength(0);
    expect(bar()).toBeNull();
    // One click on Edit opened the editor in the task list.
    expect(await screen.findByRole('form', { name: /Edit/ }).catch(() => null)).not.toBeUndefined();
  });

  it('Hide earnings masks the total', async () => {
    const s = demoState();
    s.hideEarnings = true;
    const user = await open(s);
    await user.click(rowsOf(YESTERDAY)[0] as HTMLElement);
    expect(screen.getByTestId('selection-total')).toHaveTextContent('••••');
    expect(screen.getByTestId('selection-total').textContent).not.toMatch(/[$€]\d/);
  });
});

describe('keyboard selection', () => {
  it('Esc clears from the selection bar too', async () => {
    const user = await open();
    const row = screen.getAllByTestId('entry').find((r) => r.hasAttribute('data-row-id')) as HTMLElement;
    act(() => row.focus());
    await user.keyboard(' ');
    expect(bar()).not.toBeNull();
    act(() => within(bar() as HTMLElement).getByRole('button', { name: 'Clear' }).focus());
    await user.keyboard('{Escape}');
    expect(bar()).toBeNull();
    expect(selectedRows()).toHaveLength(0);
  });

  it('has one tab stop, arrows move it, Space selects, Ctrl+Space toggles, Shift+Arrow extends, Esc clears', async () => {
    const user = await open();
    const all = (): HTMLElement[] => screen.getAllByTestId('entry').filter((r) => r.hasAttribute('data-row-id'));
    expect(all().filter((r) => r.tabIndex === 0)).toHaveLength(1);
    const keyAt = (i: number): string => all()[i]?.getAttribute('data-sel-key') ?? '';
    // Positions of the first row of each of the next task-days, so every step crosses into a different one.
    const p1 = all().findIndex((r) => r.getAttribute('data-sel-key') !== keyAt(0));
    const p2 = all().findIndex((r, i) => i > p1 && r.getAttribute('data-sel-key') !== keyAt(p1));
    const p3 = all().findIndex((r, i) => i > p2 && r.getAttribute('data-sel-key') !== keyAt(p2));
    expect([p1, p2, p3].every((p) => p > 0)).toBe(true);
    act(() => (all()[0] as HTMLElement).focus());
    await user.keyboard('{ArrowDown}'.repeat(p1));
    expect(document.activeElement).toBe(all()[p1]);
    expect(all().filter((r) => r.tabIndex === 0)).toEqual([all()[p1]]);
    expect(selectedRows()).toHaveLength(0);
    // Space selects only this one.
    await user.keyboard(' ');
    expect(new Set(selectedRows().map((r) => r.getAttribute('data-sel-key')))).toEqual(new Set([keyAt(p1)]));
    // Ctrl+Space adds another without losing the first.
    await user.keyboard('{ArrowDown}'.repeat(p2 - p1));
    await user.keyboard('{Control>} {/Control}');
    expect(new Set(selectedRows().map((r) => r.getAttribute('data-sel-key')))).toEqual(new Set([keyAt(p1), keyAt(p2)]));
    // Shift+Arrow extends from the anchor (the last one chosen on its own).
    await user.keyboard('{Shift>}' + '{ArrowDown}'.repeat(p3 - p2) + '{/Shift}');
    const keys = new Set(selectedRows().map((r) => r.getAttribute('data-sel-key')));
    expect(keys.has(keyAt(p2)) && keys.has(keyAt(p3))).toBe(true);
    expect(screen.getByTestId('selection-live')).toHaveTextContent(/\d+ tasks? selected/);
    await user.keyboard('{Escape}');
    expect(selectedRows()).toHaveLength(0);
    expect(bar()).toBeNull();
    expect(screen.getByTestId('selection-live')).toHaveTextContent('Selection cleared');
  });

  it('Ctrl+A selects everything on screen, and Cmd+A does the same on macOS', async () => {
    const user = await open();
    const first = screen.getAllByTestId('entry').find((r) => r.hasAttribute('data-row-id')) as HTMLElement;
    act(() => first.focus());
    await user.keyboard('{Control>}a{/Control}');
    const selectable = screen.getAllByTestId('entry').filter((r) => r.hasAttribute('data-row-id'));
    expect(selectedRows().length).toBe(selectable.length);
    await user.keyboard('{Escape}');
    await user.keyboard('{Meta>}a{/Meta}');
    expect(selectedRows().length).toBe(selectable.length);
    expect(screen.getByTestId('selection-live')).toHaveTextContent(/\d+ tasks selected/);
  });
});

describe('the selection bar and the filter', () => {
  it('shows the Billable total of exactly the Timeline rows, rounded per task and day', async () => {
    const user = await open();
    // Logo concepts today: three rows of one task-day. Its Billable figure is the day's row, not a sum of pieces.
    const logo = rowsOf(TODAY).filter((r) => nameOf(r) === 'Logo concepts');
    await user.click(logo[0] as HTMLElement);
    const dayBillable = within(screen.getByRole('article', { name: TODAY })).getByTestId('day-billable').textContent ?? '';
    expect(dayBillable).toMatch(/h/);
    expect(screen.getByTestId('selection-total')).toHaveTextContent(/Total Billable \d+h \d{2}m/);
  });

  it('keeps the selection when a filter hides it, and says how many are not on screen', async () => {
    const user = await open();
    await user.click(rowsOf(TODAY).find((r) => nameOf(r) === 'Logo concepts') as HTMLElement);
    await ctrl(user, rowsOf(YESTERDAY)[0] as HTMLElement);
    expect(bar()).not.toBeNull();
    const search = screen.getByRole('searchbox', { name: /Search timeline/ });
    await user.type(search, 'zzzz-no-such-task');
    await waitFor(() => expect(screen.queryAllByTestId('entry')).toHaveLength(0), { timeout: 2000 });
    expect(within(bar() as HTMLElement).getByTestId('selection-count')).toHaveTextContent('2 tasks selected');
    await waitFor(() => expect(bar()).toHaveTextContent(/2 of them are not on screen/));
    await user.click(within(screen.getByTestId('task-filter-timeline')).getByRole('button', { name: 'Clear filter' }));
    await waitFor(() => expect(screen.queryAllByTestId('entry').length).toBeGreaterThan(0));
    expect(within(bar() as HTMLElement).getByTestId('selection-count')).toHaveTextContent('2 tasks selected');
    await waitFor(() => expect(bar()).not.toHaveTextContent(/not on screen/));
  });

  it('Clear empties the selection and takes the bar away', async () => {
    const user = await open();
    await user.click(rowsOf(YESTERDAY)[0] as HTMLElement);
    await user.click(within(bar() as HTMLElement).getByRole('button', { name: 'Clear' }));
    expect(bar()).toBeNull();
    expect(selectedRows()).toHaveLength(0);
  });
});

describe('exporting a selection', () => {
  async function selectTwo(user: ReturnType<typeof userEvent.setup>) {
    await user.click(rowsOf(TODAY).find((r) => nameOf(r) === 'Logo concepts') as HTMLElement);
    await ctrl(user, rowsOf('Tue 10 Mar 2026')[0] as HTMLElement);
  }

  it('starts on Selected, sends task and day ids with no figures of its own, and keeps the selection', async () => {
    const user = await open();
    await selectTwo(user);
    await user.click(within(bar() as HTMLElement).getByRole('button', { name: 'Export selected' }));
    const dialog = await screen.findByRole('dialog', { name: 'Export' });
    expect(within(dialog).getByRole('radio', { name: 'Selected (2)' })).toBeChecked();
    expect(within(dialog).getByTestId('selection-scope-note')).toHaveTextContent(/analysis sheets count those entries only/);
    await user.click(within(dialog).getByRole('button', { name: 'Export Excel' }));
    await within(dialog).findByTestId('export-result');
    const req = state.exports[0]?.request;
    expect(req?.analytics).toEqual([]);
    expect(req?.selection).toHaveLength(2);
    expect(req?.selection?.map((e) => e.taskId)).toContain('t-logo');
    expect(req?.selection?.every((e) => /^\d{4}-\d{2}-\d{2}$/.test(e.day))).toBe(true);
    // Sent: ids and days only, never totals.
    expect(Object.keys(req ?? {}).sort()).toEqual(['analytics', 'clientZone', 'dayZone', 'includeEarnings', 'myZone', 'segmentShifts', 'selection']);
    expect(within(dialog).getByTestId('selection-after-export')).toBeInTheDocument();
    expect(bar()).not.toBeNull();
  });

  it('All in period sends no selection and the analysis sheets, as before', async () => {
    const user = await open();
    await selectTwo(user);
    await user.click(screen.getByRole('button', { name: /^Export \(2 selected\)$/ }));
    const dialog = await screen.findByRole('dialog', { name: 'Export' });
    await user.click(within(dialog).getByRole('radio', { name: 'All in period' }));
    await user.click(within(dialog).getByRole('button', { name: 'Export Excel' }));
    await within(dialog).findByTestId('export-result');
    expect(state.exports[0]?.request.selection).toBeNull();
    expect(state.exports[0]?.request.analytics.length).toBeGreaterThan(0);
  });

  it('exports a CSV and a PDF selection too, the PDF over exactly the selected days', async () => {
    const user = await open();
    await selectTwo(user);
    await user.click(screen.getByRole('button', { name: /^Export \(2 selected\)$/ }));
    const dialog = await screen.findByRole('dialog', { name: 'Export' });
    await user.click(within(dialog).getByRole('radio', { name: 'CSV (.csv)' }));
    await user.click(within(dialog).getByRole('button', { name: 'Export CSV' }));
    await within(dialog).findByTestId('export-result');
    expect(state.exports[0]).toMatchObject({ kind: 'csv', request: { analytics: [] } });
    expect(state.exports[0]?.request.selection).toHaveLength(2);
    await user.click(within(dialog).getByRole('radio', { name: 'PDF timesheet (.pdf)' }));
    expect(within(dialog).getByTestId('pdf-selection-summary')).toHaveTextContent(/only the 2 selected tasks, from 2026-03-10 to 2026-03-12/);
    await user.click(within(dialog).getByRole('button', { name: 'Export PDF' }));
    await waitFor(() => expect(state.pdfExports).toHaveLength(1));
    expect(state.pdfExports[0]).toMatchObject({ projectId: null, from: '2026-03-10', to: '2026-03-12' });
    expect(state.pdfExports[0]?.selection).toHaveLength(2);
  });

  it('blocks an empty selection in the dialog, and never calls the backend', async () => {
    const user = await open();
    await user.click(screen.getByRole('button', { name: 'Export' }));
    const dialog = await screen.findByRole('dialog', { name: 'Export' });
    expect(within(dialog).getByRole('radio', { name: 'All in period' })).toBeChecked();
    await user.click(within(dialog).getByRole('radio', { name: 'Selected (0)' }));
    expect(within(dialog).getByTestId('selection-empty')).toHaveTextContent(/Nothing is selected/);
    expect(within(dialog).getByRole('button', { name: 'Export Excel' })).toBeDisabled();
    expect(state.exports).toHaveLength(0);
  });

  it('clears the selection when the day zone changes, since the same date would be a different stretch of time', async () => {
    const user = await open();
    await user.click(rowsOf(YESTERDAY)[0] as HTMLElement);
    expect(bar()).not.toBeNull();
    await user.click(screen.getByRole('button', { name: /^UTC$/ }));
    await waitFor(() => expect(bar()).toBeNull());
    expect(screen.getByTestId('selection-live')).toHaveTextContent(/day zone changed/);
  });
});
