// The project editor, against findings of the review 20261102-2005 (R5, R8, R11, R14, R17, and the form side of R10)
// and the removal of a price version. Each describe is named after its finding.
import { clearMocks } from '@tauri-apps/api/mocks';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { boot as bootApp, polyfillDom } from '../../components/testKit';
import { api } from '../../lib/api';
import { MASK } from '../../lib/billing';
import { parseIso, startOfDay, toIso } from '../../lib/tz';
import { demoState } from '../../mocks/demoSeed';
import { DEVICE_ID, type MockState } from '../../mocks/ipcMock';

beforeEach(() => {
  polyfillDom();
  window.localStorage.clear();
});
afterEach(() => {
  clearMocks();
  vi.restoreAllMocks();
  window.localStorage.clear();
});

type User = ReturnType<typeof userEvent.setup>;

let state: MockState;
const boot = (s: MockState) => {
  state = s;
  return bootApp(s);
};
const calls = (cmd: string) => state.calls.filter((c) => c.cmd === cmd).map((c) => c.args as Record<string, unknown> & { input: Record<string, unknown> });
const stamp = { at: '2026-01-01T00:00:00Z', by: DEVICE_ID };
const ASK = 'Leave without saving?';
const BOUND = "the price's start date must be between 2000-01-01 and 2100-01-01";

async function openProjects(s: MockState): Promise<User> {
  const user = userEvent.setup();
  boot(s);
  await user.click(await screen.findByRole('tab', { name: 'Projects' }));
  await screen.findByRole('region', { name: 'Projects' });
  return user;
}
async function editProject(s: MockState, name: string): Promise<{ user: User; form: HTMLElement }> {
  const user = await openProjects(s);
  await user.click(await screen.findByRole('button', { name: `Edit ${name}` }));
  return { user, form: await screen.findByRole('form', { name: `Edit project ${name}` }) };
}
async function newProject(s: MockState): Promise<{ user: User; form: HTMLElement }> {
  const user = await openProjects(s);
  await user.click(screen.getByRole('button', { name: 'New project' }));
  return { user, form: screen.getByRole('form', { name: 'New project' }) };
}
const box = (form: HTMLElement, name: string) => within(form).getByRole('textbox', { name });
const tickerSetRate = (): HTMLElement => {
  const link = screen.getAllByRole('button', { name: 'Set a rate' }).find((b) => b.closest('.ticker'));
  if (!link) throw new Error('the ticker has no Set a rate');
  return link;
};
const asking = () => screen.queryByRole('dialog', { name: ASK });
const selected = (tab: string) => expect(screen.getByRole('tab', { name: tab })).toHaveAttribute('aria-selected', 'true');

/** The demo, with the running task's project (Brand refresh) left without a price. */
function noBrandRate(): MockState {
  const s = demoState();
  s.rates = s.rates.filter((r) => r.projectId !== 'p-brand');
  return s;
}
/** The demo, plus a fixed-fee project: fee 1,000.00 EUR, measured at 50.00 EUR/h. */
function withFixedFee(s: MockState = demoState()): MockState {
  s.projects.push({ id: 'p-print', name: 'Print run (fixed fee)', color: '#0ea5e9', archived: false, billable: true, budgetHours: null, clientZone: null, createdAt: '2026-01-01T00:00:00Z', billingType: 'fixedFee', fixedFeeCents: 100_000, feeCurrency: 'EUR', hasTasks: false });
  s.rates.push({ id: 'r-print', projectId: 'p-print', effectiveFrom: '2026-01-01T00:00:00Z', rateCents: 5000, currency: 'EUR', deleted: false, stamp });
  return s;
}

describe('R5: the rate history names the day in the active zone', () => {
  /** A price set from `day` in `zone` (its instant is that day's midnight there), listed in the editor of Website. */
  async function historyOf(zone: string, day: string): Promise<HTMLElement> {
    const s = demoState();
    s.settings = { ...s.settings, myZone: zone, activeZone: zone };
    s.now = parseIso('2026-07-15T10:00:00Z');
    s.rates = [{ id: 'rx', projectId: 'p-web', effectiveFrom: toIso(startOfDay(day, zone)), rateCents: 7000, currency: 'EUR', deleted: false, stamp }, ...s.rates.filter((r) => r.projectId !== 'p-web')];
    const { form } = await editProject(s, 'Website');
    return within(form).getByRole('heading', { name: 'Rate history' }).parentElement as HTMLElement;
  }

  // East of UTC, the midnight of a day falls on the evening before in UTC, which is what the list showed.
  it.each([
    ['Europe/Lisbon', '2026-07-01', '2026-06-30'],
    ['Asia/Tokyo', '2026-07-01', '2026-06-30'],
    ['Australia/Sydney', '2026-07-01', '2026-06-30'],
  ])('%s: a price set from %s is listed as that day, not as %s', async (zone, day, utcDay) => {
    const history = await historyOf(zone, day);
    expect(history).toHaveTextContent(`from ${day}`);
    expect(history).not.toHaveTextContent(`from ${utcDay}`);
  });

  // West of UTC, local midnight falls on the same UTC date, so the old list was right there. This row guards that the fix keeps it so.
  it('America/New_York: a zone west of UTC lists the day it always listed (a control, it passes without the fix too)', async () => {
    const history = await historyOf('America/New_York', '2026-07-01');
    expect(history).toHaveTextContent('from 2026-07-01');
  });
});

describe('R8: "Set a rate" in the ticker while the Projects tab is the one shown', () => {
  it('opens the editor of the running task\'s project, as it does from another tab', async () => {
    const user = await openProjects(noBrandRate());
    await user.click(tickerSetRate());
    expect(await screen.findByRole('form', { name: 'Edit project Brand refresh' })).toBeVisible();
    expect(asking()).toBeNull();
  });

  it('opens it again after the editor was closed, and does not keep a request that nobody asked for', async () => {
    const user = await openProjects(noBrandRate());
    await user.click(tickerSetRate());
    const form = await screen.findByRole('form', { name: 'Edit project Brand refresh' });
    await user.click(within(form).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('form', { name: 'Edit project Brand refresh' })).toBeNull();
    await user.click(tickerSetRate());
    expect(await screen.findByRole('form', { name: 'Edit project Brand refresh' })).toBeVisible();
  });

  it('asks before it takes the place of an editor with unsaved changes; Keep editing keeps it and Leave and discard opens the other one', async () => {
    const { user, form } = await editProject(noBrandRate(), 'Website');
    await user.type(box(form, 'Project name'), ' 2');
    await user.click(tickerSetRate());
    const ask = await screen.findByRole('dialog', { name: ASK });
    expect(screen.queryByRole('form', { name: 'Edit project Brand refresh' })).toBeNull();
    await user.click(within(ask).getByRole('button', { name: 'Keep editing' }));
    await waitFor(() => expect(asking()).toBeNull());
    expect(box(screen.getByRole('form', { name: 'Edit project Website' }), 'Project name')).toHaveValue('Website 2');
    // The request went with the answer: pressing it again asks again.
    await user.click(tickerSetRate());
    await user.click(within(await screen.findByRole('dialog', { name: ASK })).getByRole('button', { name: 'Leave and discard' }));
    expect(await screen.findByRole('form', { name: 'Edit project Brand refresh' })).toBeVisible();
    expect(screen.queryByRole('form', { name: 'Edit project Website' })).toBeNull();
  });

  it('"Choose again" on the replaced-colour notice asks before it replaces a changed editor, and then puts the cursor in the colour choice', async () => {
    const { user, form: create } = await newProject(demoState());
    await user.type(box(create, 'Project name'), 'Retail');
    await user.clear(box(create, 'Hex'));
    await user.type(box(create, 'Hex'), '#2563eb'); // the colour of Brand refresh, so the backend swaps it
    await user.click(within(create).getByRole('button', { name: 'Create project' }));
    const notice = await screen.findByTestId('color-notice');
    await user.click(await screen.findByRole('button', { name: 'Edit Website' }));
    const web = await screen.findByRole('form', { name: 'Edit project Website' });
    await user.type(box(web, 'Project name'), ' 2');
    await user.click(within(notice).getByRole('button', { name: /Choose again/ }));
    const ask = await screen.findByRole('dialog', { name: ASK });
    expect(screen.queryByRole('form', { name: 'Edit project Retail' })).toBeNull();
    await user.click(within(ask).getByRole('button', { name: 'Leave and discard' }));
    const retail = await screen.findByRole('form', { name: 'Edit project Retail' });
    await waitFor(() => expect(retail.contains(document.activeElement)).toBe(true));
    expect(document.activeElement).not.toBe(box(retail, 'Project name'));
    expect(screen.queryByRole('form', { name: 'Edit project Website' })).toBeNull();
  });

  it('"Choose again" that is answered with Keep editing leaves no request behind to move the cursor later (review U5)', async () => {
    const { user, form: create } = await newProject(demoState());
    await user.type(box(create, 'Project name'), 'Retail');
    await user.clear(box(create, 'Hex'));
    await user.type(box(create, 'Hex'), '#2563eb');
    await user.click(within(create).getByRole('button', { name: 'Create project' }));
    const notice = await screen.findByTestId('color-notice');
    await user.click(await screen.findByRole('button', { name: 'Edit Website' }));
    const web = await screen.findByRole('form', { name: 'Edit project Website' });
    await user.type(box(web, 'Project name'), ' 2');
    await user.click(within(notice).getByRole('button', { name: /Choose again/ }));
    await user.click(within(await screen.findByRole('dialog', { name: ASK })).getByRole('button', { name: 'Keep editing' }));
    await waitFor(() => expect(asking()).toBeNull());
    // The user gives the changes up on purpose and opens Retail by hand: nothing asked the cursor to go into its form.
    await user.click(within(web).getByRole('button', { name: 'Cancel' }));
    await user.click(screen.getByRole('button', { name: 'Edit Retail' }));
    const retail = await screen.findByRole('form', { name: 'Edit project Retail' });
    expect(retail.contains(document.activeElement)).toBe(false);
  });
});

describe('R10: a project form with changes that are not saved asks before it is lost', () => {
  it.each<[string, (user: User, form: HTMLElement) => Promise<void>]>([
    ['the name is changed', async (user, form) => void (await user.type(box(form, 'Project name'), ' 2'))],
    ['the budget is typed', async (user, form) => void (await user.type(box(form, 'Budget hours'), '5'))],
    [
      'the price is changed',
      async (user, form) => {
        await user.clear(box(form, 'Price'));
        await user.type(box(form, 'Price'), '65');
      },
    ],
    ['a project is made non-billable', async (user, form) => void (await user.click(within(form).getByRole('checkbox', { name: 'Billable project' })))],
    ['another colour is chosen', async (user, form) => void (await user.click(within(form).getByRole('radio', { name: 'Colour #db2777' })))],
    ['a rounding override is ticked', async (user, form) => void (await user.click(within(form).getByRole('checkbox', { name: 'Override the global rounding for this project' })))],
  ])('when %s, a click on another tab asks first, and Keep editing leaves the form as it was', async (_what, change) => {
    const { user, form } = await editProject(demoState(), 'Website');
    await change(user, form);
    await user.click(screen.getByRole('tab', { name: 'Timeline' }));
    const ask = within(await screen.findByRole('dialog', { name: ASK }));
    await user.click(ask.getByRole('button', { name: 'Keep editing' }));
    await waitFor(() => expect(asking()).toBeNull());
    selected('Projects');
    expect(screen.getByRole('form', { name: 'Edit project Website' })).toBeVisible();
  });

  it('Leave and discard shows the other tab, and the editor is gone on the way back', async () => {
    const { user, form } = await editProject(demoState(), 'Website');
    await user.type(box(form, 'Project name'), ' 2');
    await user.click(screen.getByRole('tab', { name: 'Billing' }));
    await user.click(within(await screen.findByRole('dialog', { name: ASK })).getByRole('button', { name: 'Leave and discard' }));
    await screen.findByRole('region', { name: 'Billing' });
    selected('Billing');
    await user.click(screen.getByRole('tab', { name: 'Projects' }));
    await screen.findByRole('region', { name: 'Projects' });
    expect(screen.queryByRole('form', { name: 'Edit project Website' })).toBeNull();
  });

  it('a New project form with a name typed asks too', async () => {
    const { user, form } = await newProject(demoState());
    await user.type(box(form, 'Project name'), 'Retail');
    await user.click(screen.getByRole('tab', { name: 'Timeline' }));
    await user.click(within(await screen.findByRole('dialog', { name: ASK })).getByRole('button', { name: 'Keep editing' }));
    expect(box(screen.getByRole('form', { name: 'New project' }), 'Project name')).toHaveValue('Retail');
    selected('Projects');
  });

  it.each<[string, (user: User, form: HTMLElement) => Promise<void>]>([
    ['nothing was changed', async () => undefined],
    [
      'a change was typed and erased',
      async (user, form) => {
        await user.type(box(form, 'Project name'), 'x');
        await user.type(box(form, 'Project name'), '{Backspace}');
      },
    ],
    [
      'the form was cancelled',
      async (user, form) => {
        await user.type(box(form, 'Project name'), ' 2');
        await user.click(within(form).getByRole('button', { name: 'Cancel' }));
      },
    ],
    [
      'the changes were saved',
      async (user, form) => {
        await user.type(box(form, 'Project name'), ' 2');
        await user.click(within(form).getByRole('button', { name: 'Save project' }));
        await waitFor(() => expect(screen.queryByRole('form', { name: /^Edit project/ })).toBeNull());
        expect(state.projects.find((p) => p.id === 'p-web')?.name).toBe('Website 2');
      },
    ],
  ])('asks nothing when %s', async (_what, act) => {
    const { user, form } = await editProject(demoState(), 'Website');
    await act(user, form);
    await user.click(screen.getByRole('tab', { name: 'Timeline' }));
    expect(asking()).toBeNull();
    selected('Timeline');
  });

  it('opening another project asks before it replaces an editor with changes, and asks nothing for one without', async () => {
    const { user, form } = await editProject(demoState(), 'Website');
    await user.type(box(form, 'Project name'), ' 2');
    await user.click(screen.getByRole('button', { name: 'Edit Brand refresh' }));
    await user.click(within(await screen.findByRole('dialog', { name: ASK })).getByRole('button', { name: 'Keep editing' }));
    expect(screen.queryByRole('form', { name: 'Edit project Brand refresh' })).toBeNull();
    expect(box(screen.getByRole('form', { name: 'Edit project Website' }), 'Project name')).toHaveValue('Website 2');
    await user.click(screen.getByRole('button', { name: 'Edit Brand refresh' }));
    await user.click(within(await screen.findByRole('dialog', { name: ASK })).getByRole('button', { name: 'Leave and discard' }));
    const brand = await screen.findByRole('form', { name: 'Edit project Brand refresh' });
    expect(screen.queryByRole('form', { name: 'Edit project Website' })).toBeNull();
    // Nothing was typed in this one.
    await user.click(screen.getByRole('button', { name: 'Edit Website' }));
    expect(await screen.findByRole('form', { name: 'Edit project Website' })).toBeVisible();
    expect(brand).not.toBeInTheDocument();
    expect(asking()).toBeNull();
  });

  it('a New project form with changes is not lost by opening a project, so opening one asks nothing', async () => {
    const { user, form } = await newProject(demoState());
    await user.type(box(form, 'Project name'), 'Retail');
    await user.click(screen.getByRole('button', { name: 'Edit Website' }));
    await screen.findByRole('form', { name: 'Edit project Website' });
    await user.click(screen.getByRole('button', { name: 'Edit Brand refresh' }));
    await screen.findByRole('form', { name: 'Edit project Brand refresh' });
    expect(asking()).toBeNull();
    expect(box(screen.getByRole('form', { name: 'New project' }), 'Project name')).toHaveValue('Retail');
  });
});

describe('review U1: closing an editor, or moving its project to the other list, asks when the form has changes', () => {
  const answer = async (user: User, button: 'Keep editing' | 'Leave and discard'): Promise<void> => {
    await user.click(within(await screen.findByRole('dialog', { name: ASK })).getByRole('button', { name: button }));
    await waitFor(() => expect(asking()).toBeNull());
  };
  const archivedWebsite = (): MockState => {
    const s = demoState();
    s.projects = s.projects.map((p) => (p.id === 'p-web' ? { ...p, archived: true } : p));
    return s;
  };

  it('the Edit button of the open editor asks before it closes it; Keep editing keeps the changes, Leave and discard drops them', async () => {
    const { user, form } = await editProject(demoState(), 'Website');
    await user.type(box(form, 'Project name'), ' 2');
    await user.click(screen.getByRole('button', { name: 'Edit Website' }));
    await answer(user, 'Keep editing');
    expect(box(screen.getByRole('form', { name: 'Edit project Website' }), 'Project name')).toHaveValue('Website 2');
    await user.click(screen.getByRole('button', { name: 'Edit Website' }));
    await answer(user, 'Leave and discard');
    expect(screen.queryByRole('form', { name: 'Edit project Website' })).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Edit Website' }));
    expect(box(await screen.findByRole('form', { name: 'Edit project Website' }), 'Project name')).toHaveValue('Website');
  });

  it('the Edit button closes an editor without changes at once, also while another form has changes', async () => {
    const { user, form: create } = await newProject(demoState());
    await user.type(box(create, 'Project name'), 'Retail');
    await user.click(screen.getByRole('button', { name: 'Edit Website' }));
    await screen.findByRole('form', { name: 'Edit project Website' });
    await user.click(screen.getByRole('button', { name: 'Edit Website' }));
    expect(asking()).toBeNull();
    expect(screen.queryByRole('form', { name: 'Edit project Website' })).toBeNull();
    expect(box(screen.getByRole('form', { name: 'New project' }), 'Project name')).toHaveValue('Retail');
  });

  it('the New project button asks before it closes a form with changes; Keep editing keeps them, Leave and discard drops them', async () => {
    const { user, form } = await newProject(demoState());
    await user.type(box(form, 'Project name'), 'Retail');
    await user.click(screen.getByRole('button', { name: 'New project' }));
    await answer(user, 'Keep editing');
    expect(box(screen.getByRole('form', { name: 'New project' }), 'Project name')).toHaveValue('Retail');
    await user.click(screen.getByRole('button', { name: 'New project' }));
    await answer(user, 'Leave and discard');
    expect(screen.queryByRole('form', { name: 'New project' })).toBeNull();
    await user.click(screen.getByRole('button', { name: 'New project' }));
    expect(box(await screen.findByRole('form', { name: 'New project' }), 'Project name')).toHaveValue('');
  });

  it('the New project button closes a form without changes at once', async () => {
    const { user } = await newProject(demoState());
    await user.click(screen.getByRole('button', { name: 'New project' }));
    expect(asking()).toBeNull();
    expect(screen.queryByRole('form', { name: 'New project' })).toBeNull();
  });

  it('Archive asks first when the editor of that project has changes: the row moves to the other list and the form would be rebuilt', async () => {
    const { user, form } = await editProject(demoState(), 'Website');
    await user.type(box(form, 'Project name'), ' 2');
    await user.click(screen.getByRole('button', { name: 'Archive Website' }));
    await answer(user, 'Keep editing');
    expect(calls('set_project_archived')).toEqual([]);
    expect(box(screen.getByRole('form', { name: 'Edit project Website' }), 'Project name')).toHaveValue('Website 2');
    await user.click(screen.getByRole('button', { name: 'Archive Website' }));
    await answer(user, 'Leave and discard');
    await waitFor(() => expect(calls('set_project_archived')).toEqual([{ id: 'p-web', archived: true }]));
  });

  it('Restore asks the same of a project in the archived list', async () => {
    const { user, form } = await editProject(archivedWebsite(), 'Website');
    await user.type(box(form, 'Project name'), ' 2');
    await user.click(screen.getByRole('button', { name: 'Restore Website' }));
    await answer(user, 'Keep editing');
    expect(calls('set_project_archived')).toEqual([]);
    expect(box(screen.getByRole('form', { name: 'Edit project Website' }), 'Project name')).toHaveValue('Website 2');
    await user.click(screen.getByRole('button', { name: 'Restore Website' }));
    await answer(user, 'Leave and discard');
    await waitFor(() => expect(calls('set_project_archived')).toEqual([{ id: 'p-web', archived: false }]));
  });

  it('Archive asks nothing when the editor of that project has no changes, or when the changes are in the editor of another project', async () => {
    const { user } = await editProject(demoState(), 'Website');
    await user.click(screen.getByRole('button', { name: 'Archive Website' }));
    await waitFor(() => expect(calls('set_project_archived')).toEqual([{ id: 'p-web', archived: true }]));
    expect(asking()).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Edit Brand refresh' }));
    const brand = await screen.findByRole('form', { name: 'Edit project Brand refresh' });
    await user.type(box(brand, 'Project name'), ' 2');
    await user.click(screen.getByRole('button', { name: 'Restore Website' }));
    await waitFor(() => expect(calls('set_project_archived')).toHaveLength(2));
    expect(asking()).toBeNull();
    expect(box(screen.getByRole('form', { name: 'Edit project Brand refresh' }), 'Project name')).toHaveValue('Brand refresh 2');
  });
});

describe('R11: removing a rounding override of a project asks first, as Settings does', () => {
  const withOverride = (): MockState => {
    const s = demoState();
    s.rounding.push({ id: 'rd1', projectId: 'p-web', effectiveFrom: '2026-01-01', incrementMinutes: 15, method: 'up', deleted: false, stamp });
    return s;
  };
  const remove = (form: HTMLElement): HTMLElement => within(within(form).getByRole('group', { name: 'Rounding for this project' })).getByRole('button', { name: /^Remove/ });

  it('shows the question of the Settings page and sends nothing until Remove rule is pressed', async () => {
    const { user, form } = await editProject(withOverride(), 'Website');
    await user.click(remove(form));
    const ask = await screen.findByRole('dialog', { name: 'Remove this rounding rule?' });
    expect(ask).toHaveTextContent('Days from that date on fall back to the previous rule. Billable figures for those days change.');
    expect(calls('delete_rounding')).toEqual([]);
    await user.click(within(ask).getByRole('button', { name: 'Remove rule' }));
    await waitFor(() => expect(calls('delete_rounding')).toEqual([{ id: 'rd1' }]));
    await waitFor(() => expect(within(form).getByText('This project follows the global rounding in Settings.')).toBeVisible());
  });

  it('Cancel and Esc leave the override where it is', async () => {
    const { user, form } = await editProject(withOverride(), 'Website');
    await user.click(remove(form));
    await user.click(within(await screen.findByRole('dialog', { name: 'Remove this rounding rule?' })).getByRole('button', { name: 'Cancel' }));
    await user.click(remove(form));
    await screen.findByRole('dialog', { name: 'Remove this rounding rule?' });
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Remove this rounding rule?' })).toBeNull());
    expect(calls('delete_rounding')).toEqual([]);
    expect(within(form).getByText(/From 2026-01-01: 15 min/)).toBeVisible();
  });
});

describe('R14: Hide earnings and the project form', () => {
  const hidden = (): MockState => {
    const s = withFixedFee();
    s.hideEarnings = true;
    return s;
  };

  it('shows the saved fee and price masked, as the rate history beside them is', async () => {
    const { form } = await editProject(hidden(), 'Print run (fixed fee)');
    expect(box(form, 'Fee')).toHaveValue(MASK);
    expect(box(form, 'Price')).toHaveValue(MASK);
    expect(box(form, 'Fee')).toHaveAttribute('readonly');
    expect(box(form, 'Price')).toHaveAttribute('readonly');
    expect(within(form).queryByDisplayValue('1000')).toBeNull();
    expect(within(form).queryByDisplayValue('50')).toBeNull();
    expect(within(form).getByText('Rate hidden')).toBeVisible();
  });

  it('shows them as they are when earnings are not hidden', async () => {
    const { form } = await editProject(withFixedFee(), 'Print run (fixed fee)');
    expect(box(form, 'Fee')).toHaveValue('1000');
    expect(box(form, 'Price')).toHaveValue('50');
    expect(within(form).queryByRole('button', { name: /^Change the/ })).toBeNull();
  });

  it('saves what was not touched as it was: the same fee, and no new price', async () => {
    const { user, form } = await editProject(hidden(), 'Print run (fixed fee)');
    await user.type(box(form, 'Project name'), ' 2');
    await user.click(within(form).getByRole('button', { name: 'Save project' }));
    await waitFor(() => expect(calls('update_project')).toHaveLength(1));
    expect(calls('update_project')[0]?.input).toMatchObject({ name: 'Print run (fixed fee) 2', billingType: 'fixedFee', fixedFeeCents: 100_000, feeCurrency: 'EUR' });
    expect(calls('set_rate')).toEqual([]);
    expect(state.rates.filter((r) => r.projectId === 'p-print')).toHaveLength(1);
  });

  it('Change shows the amount to edit it, and the new fee and price are saved', async () => {
    const { user, form } = await editProject(hidden(), 'Print run (fixed fee)');
    await user.click(within(form).getByRole('button', { name: 'Change the fee' }));
    expect(box(form, 'Fee')).toHaveValue('1000');
    expect(box(form, 'Fee')).not.toHaveAttribute('readonly');
    expect(box(form, 'Fee')).toHaveFocus();
    expect(box(form, 'Price')).toHaveValue(MASK);
    await user.clear(box(form, 'Fee'));
    await user.type(box(form, 'Fee'), '1200');
    await user.click(within(form).getByRole('button', { name: 'Change the price' }));
    expect(box(form, 'Price')).toHaveValue('50');
    await user.clear(box(form, 'Price'));
    await user.type(box(form, 'Price'), '55');
    await user.click(within(form).getByRole('button', { name: 'Save project' }));
    await waitFor(() => expect(calls('set_rate')).toHaveLength(1));
    expect(calls('update_project')[0]?.input).toMatchObject({ fixedFeeCents: 120_000, feeCurrency: 'EUR' });
    expect(calls('set_rate')[0]?.input).toMatchObject({ projectId: 'p-print', rateCents: 5500, currency: 'EUR' });
  });

  it('a new project has nothing to hide: what is typed in the price shows as it is typed', async () => {
    const s = demoState();
    s.hideEarnings = true;
    const { user, form } = await newProject(s);
    await user.type(box(form, 'Price'), '45');
    expect(box(form, 'Price')).toHaveValue('45');
    expect(within(form).queryByRole('button', { name: /^Change the/ })).toBeNull();
  });

  it('masks a form that is already open when Hide earnings is switched on, and shows it again when it is switched off', async () => {
    const { user, form } = await editProject(withFixedFee(), 'Print run (fixed fee)');
    expect(box(form, 'Fee')).toHaveValue('1000');
    await user.click(screen.getByRole('button', { name: 'Hide earnings' }));
    await waitFor(() => expect(box(form, 'Fee')).toHaveValue(MASK));
    expect(box(form, 'Price')).toHaveValue(MASK);
    await user.click(within(form).getByRole('button', { name: 'Change the fee' }));
    expect(box(form, 'Fee')).toHaveValue('1000');
    await user.click(screen.getByRole('button', { name: 'Hide earnings' }));
    await waitFor(() => expect(box(form, 'Price')).toHaveValue('50'));
    expect(box(form, 'Fee')).toHaveValue('1000');
  });
});

describe('R17: a project made while its price is refused', () => {
  /** A New project form for "Retail" with a price that applies from a date in April, filled in; the first set_rate is refused. */
  async function refusedOnce(): Promise<{ user: User; form: HTMLElement }> {
    const spy = vi.spyOn(api, 'setRate');
    spy.mockRejectedValueOnce({ code: 'validation', message: BOUND });
    const { user, form } = await newProject(demoState());
    await user.type(box(form, 'Project name'), 'Retail');
    await user.type(box(form, 'Price'), '70');
    await user.click(within(form).getByRole('radio', { name: 'Applies from a date' }));
    fireEvent.change(within(form).getByLabelText('From date'), { target: { value: '2026-04-01' } });
    await user.click(within(form).getByRole('button', { name: 'Create project' }));
    return { user, form };
  }

  it('keeps the form open as the editor of the project that was made, and says the price was refused and why', async () => {
    await refusedOnce();
    const form = await screen.findByRole('form', { name: 'Edit project Retail' });
    expect(await within(form).findByTestId('project-error')).toHaveTextContent(`The project was saved, but the price was not: ${BOUND}.`);
    expect(within(form).getByRole('button', { name: 'Save project' })).toBeVisible();
    expect(within(form).queryByRole('button', { name: 'Create project' })).toBeNull();
    expect(state.projects.filter((p) => p.name === 'Retail')).toHaveLength(1);
    expect(box(form, 'Project name')).toHaveValue('Retail');
    expect(box(form, 'Price')).toHaveValue('70');
  });

  it('saves the project that was made, not a second one, and does not call its own name taken, when it is submitted again', async () => {
    const { user } = await refusedOnce();
    const form = await screen.findByRole('form', { name: 'Edit project Retail' });
    await user.click(within(form).getByRole('button', { name: 'Save project' }));
    await waitFor(() => expect(state.rates.some((r) => r.projectId === state.projects.find((p) => p.name === 'Retail')?.id)).toBe(true));
    expect(within(form).queryByText(/already exists/)).toBeNull();
    expect(calls('create_project')).toHaveLength(1);
    expect(calls('update_project')).toHaveLength(1);
    const made = state.projects.find((p) => p.name === 'Retail');
    expect(calls('update_project')[0]).toMatchObject({ id: made?.id });
    expect(state.projects.filter((p) => p.name === 'Retail')).toHaveLength(1);
    // The price reached the mock this time, and the form is done.
    expect(state.rates.find((r) => r.projectId === made?.id)).toMatchObject({ rateCents: 7000, effectiveFrom: toIso(startOfDay('2026-04-01', 'Europe/Lisbon')) });
    await waitFor(() => expect(screen.queryByRole('form', { name: 'Edit project Retail' })).toBeNull());
  });

  it('says the same of a rounding override that is refused', async () => {
    const spy = vi.spyOn(api, 'setRounding');
    spy.mockRejectedValueOnce({ code: 'validation', message: 'increment must be at most 1440 minutes' });
    const { user, form } = await newProject(demoState());
    await user.type(box(form, 'Project name'), 'Retail');
    await user.click(within(form).getByRole('checkbox', { name: 'Override the global rounding for this project' }));
    await user.click(within(form).getByRole('button', { name: 'Create project' }));
    const again = await screen.findByRole('form', { name: 'Edit project Retail' });
    expect(await within(again).findByTestId('project-error')).toHaveTextContent('The project was saved, but the rounding was not: increment must be at most 1440 minutes.');
    expect(calls('create_project')).toHaveLength(1);
  });
});

describe('removing a price version', () => {
  const dialogOf = () => screen.findByRole('dialog', { name: 'Remove this price?' });
  const removeButton = (form: HTMLElement, day: string) => within(form).getByRole('button', { name: `Remove the price from ${day}` });

  it('has a Remove beside each version of the rate history, named by its day', async () => {
    const { form } = await editProject(demoState(), 'Brand refresh');
    const items = within(within(form).getByRole('heading', { name: 'Rate history' }).parentElement as HTMLElement).getAllByRole('listitem');
    expect(items).toHaveLength(2);
    expect(removeButton(form, '2026-03-09')).toBeVisible();
    expect(removeButton(form, '2026-01-01')).toBeVisible();
  });

  it('asks first, says that past earnings change except what is on billing summaries, and sends nothing before the answer', async () => {
    const { user, form } = await editProject(demoState(), 'Brand refresh');
    await user.click(removeButton(form, '2026-03-09'));
    const ask = await dialogOf();
    expect(ask).toHaveTextContent('Past earnings change, except what is on billing summaries');
    expect(ask).toHaveTextContent('Mon 9 Mar 2026');
    expect(calls('delete_rate_version')).toEqual([]);
    await user.click(within(ask).getByRole('button', { name: 'Cancel' }));
    expect(calls('delete_rate_version')).toEqual([]);
    expect(removeButton(form, '2026-03-09')).toBeVisible();
  });

  it('removes a price that has started, confirmed, and the version before it applies again', async () => {
    const { user, form } = await editProject(demoState(), 'Brand refresh');
    await user.click(removeButton(form, '2026-03-09'));
    await user.click(within(await dialogOf()).getByRole('button', { name: 'Remove price' }));
    await waitFor(() => expect(calls('delete_rate_version')).toEqual([{ id: 'r2', confirmRetroactive: true }]));
    await waitFor(() => expect(within(form).queryByRole('button', { name: 'Remove the price from 2026-03-09' })).toBeNull());
    expect(within(form).getByRole('button', { name: 'Remove the price from 2026-01-01' })).toBeVisible();
    // The Price field followed the price now in force, so Save does not put the removed one back.
    expect(box(form, 'Price')).toHaveValue('80');
    await user.type(box(form, 'Project name'), ' 2');
    await user.click(within(form).getByRole('button', { name: 'Save project' }));
    await waitFor(() => expect(calls('update_project')).toHaveLength(1));
    expect(calls('set_rate')).toEqual([]);
  });

  it('after the Price field followed the price now in force, leaving the tab asks nothing: the field following is not a change of the user', async () => {
    const { user, form } = await editProject(demoState(), 'Brand refresh');
    await user.click(removeButton(form, '2026-03-09'));
    await user.click(within(await dialogOf()).getByRole('button', { name: 'Remove price' }));
    await waitFor(() => expect(box(form, 'Price')).toHaveValue('80'));
    await user.click(screen.getByRole('tab', { name: 'Timeline' }));
    expect(asking()).toBeNull();
    selected('Timeline');
  });

  it('keeps a price someone is typing when another version is removed', async () => {
    const { user, form } = await editProject(demoState(), 'Brand refresh');
    await user.clear(box(form, 'Price'));
    await user.type(box(form, 'Price'), '95');
    await user.click(removeButton(form, '2026-03-09'));
    await user.click(within(await dialogOf()).getByRole('button', { name: 'Remove price' }));
    await waitFor(() => expect(calls('delete_rate_version')).toHaveLength(1));
    await waitFor(() => expect(within(form).queryByRole('button', { name: 'Remove the price from 2026-03-09' })).toBeNull());
    expect(box(form, 'Price')).toHaveValue('95');
  });

  describe('a price and its currency are one value (review U2)', () => {
    /** Website: 80.00 USD from January, 60.00 EUR from February, which is the price in force. */
    function twoCurrencies(): MockState {
      const s = demoState();
      s.rates = [
        ...s.rates.filter((r) => r.projectId !== 'p-web'),
        { id: 'w1', projectId: 'p-web', effectiveFrom: '2026-01-01T00:00:00Z', rateCents: 8000, currency: 'USD', deleted: false, stamp },
        { id: 'w2', projectId: 'p-web', effectiveFrom: '2026-02-01T00:00:00Z', rateCents: 6000, currency: 'EUR', deleted: false, stamp },
      ];
      return s;
    }
    const removeInForce = async (user: User, form: HTMLElement): Promise<void> => {
      await user.click(removeButton(form, '2026-02-01'));
      await user.click(within(await dialogOf()).getByRole('button', { name: 'Remove price' }));
      await waitFor(() => expect(calls('delete_rate_version')).toEqual([{ id: 'w2', confirmRetroactive: true }]));
      await waitFor(() => expect(within(form).queryByRole('button', { name: 'Remove the price from 2026-02-01' })).toBeNull());
    };

    it('a price that was typed keeps the currency it was typed with, and is saved in it', async () => {
      const { user, form } = await editProject(twoCurrencies(), 'Website');
      const currency = within(form).getByRole('combobox', { name: 'Currency' });
      expect(currency).toHaveValue('EUR');
      await user.clear(box(form, 'Price'));
      await user.type(box(form, 'Price'), '95');
      await removeInForce(user, form);
      expect(box(form, 'Price')).toHaveValue('95');
      expect(currency).toHaveValue('EUR');
      await user.click(within(form).getByRole('button', { name: 'Save project' }));
      await waitFor(() => expect(calls('set_rate')).toHaveLength(1));
      expect(calls('set_rate')[0]?.input).toMatchObject({ projectId: 'p-web', rateCents: 9500, currency: 'EUR' });
    });

    it('a currency that was chosen keeps its price, so the form does not pair a price with a currency nobody chose', async () => {
      const { user, form } = await editProject(twoCurrencies(), 'Website');
      const currency = within(form).getByRole('combobox', { name: 'Currency' });
      await user.selectOptions(currency, 'USD');
      await removeInForce(user, form);
      expect(currency).toHaveValue('USD');
      expect(box(form, 'Price')).toHaveValue('60');
    });

    it('with neither changed, both follow the price now in force', async () => {
      const { user, form } = await editProject(twoCurrencies(), 'Website');
      await removeInForce(user, form);
      expect(box(form, 'Price')).toHaveValue('80');
      expect(within(form).getByRole('combobox', { name: 'Currency' })).toHaveValue('USD');
    });
  });

  it('says where the effect ends when a later version takes over: the question names the day that version starts (review U3)', async () => {
    const { user, form } = await editProject(demoState(), 'Brand refresh');
    await user.click(removeButton(form, '2026-01-01'));
    const ask = await dialogOf();
    expect(ask).toHaveTextContent('From Thu 1 Jan 2026 until Mon 9 Mar 2026');
    expect(ask).toHaveTextContent('From Mon 9 Mar 2026 on they stay as they are');
    expect(ask).toHaveTextContent('Past earnings change');
    await user.click(within(ask).getByRole('button', { name: 'Cancel' }));
    // The newest version has nothing after it, so its effect does not end.
    await user.click(removeButton(form, '2026-03-09'));
    const newest = await dialogOf();
    expect(newest).toHaveTextContent('From Mon 9 Mar 2026 on, earnings use the price before it');
    expect(newest).not.toHaveTextContent('until');
  });

  it('removing a version that is not the one in force leaves the price in force, and the field that shows it, as they are (review U3)', async () => {
    const { user, form } = await editProject(demoState(), 'Brand refresh');
    await user.click(removeButton(form, '2026-01-01'));
    await user.click(within(await dialogOf()).getByRole('button', { name: 'Remove price' }));
    await waitFor(() => expect(within(form).queryByRole('button', { name: 'Remove the price from 2026-01-01' })).toBeNull());
    expect(box(form, 'Price')).toHaveValue('90');
  });

  it('a project that is not billable lists its price versions, each with a Remove, so a price the sync warning names can be removed (review U4)', async () => {
    const s = demoState();
    s.projects = s.projects.map((p) => (p.id === 'p-web' ? { ...p, billable: false } : p));
    s.rates.push({ id: 'r-bad', projectId: 'p-web', effectiveFrom: '2150-01-01T00:00:00Z', rateCents: 6500, currency: 'EUR', deleted: false, stamp });
    const { user, form } = await editProject(s, 'Website');
    expect(within(form).queryByRole('textbox', { name: 'Price' })).toBeNull();
    const heading = within(form).getByRole('heading', { name: 'Rate history' });
    expect(within(heading.parentElement as HTMLElement).getAllByRole('listitem')).toHaveLength(2);
    await user.click(removeButton(form, '2150-01-01'));
    await user.click(within(await dialogOf()).getByRole('button', { name: 'Remove price' }));
    await waitFor(() => expect(calls('delete_rate_version')).toEqual([{ id: 'r-bad', confirmRetroactive: true }]));
    await waitFor(() => expect(within(form).queryByRole('button', { name: 'Remove the price from 2150-01-01' })).toBeNull());
  });

  it('a project that is not billable and has no price versions shows no rate history', async () => {
    const s = demoState();
    s.projects = s.projects.map((p) => (p.id === 'p-web' ? { ...p, billable: false } : p));
    s.rates = s.rates.filter((r) => r.projectId !== 'p-web');
    const { form } = await editProject(s, 'Website');
    expect(within(form).queryByRole('heading', { name: 'Rate history' })).toBeNull();
  });

  it('says that nothing changes for a price that has not started yet', async () => {
    const s = demoState();
    s.rates.push({ id: 'r-ahead', projectId: 'p-web', effectiveFrom: '2026-04-01T00:00:00Z', rateCents: 6500, currency: 'EUR', deleted: false, stamp });
    const { user, form } = await editProject(s, 'Website');
    await user.click(removeButton(form, '2026-04-01'));
    const ask = await dialogOf();
    expect(ask).toHaveTextContent('Wed 1 Apr 2026');
    expect(ask).toHaveTextContent('has not started');
    expect(ask).not.toHaveTextContent('Past earnings change');
    await user.click(within(ask).getByRole('button', { name: 'Remove price' }));
    await waitFor(() => expect(calls('delete_rate_version')).toEqual([{ id: 'r-ahead', confirmRetroactive: true }]));
    // The price in force is the same, and the field was not touched.
    expect(box(form, 'Price')).toHaveValue('60');
  });

  it('shows a refusal in the form and keeps the version', async () => {
    vi.spyOn(api, 'deleteRateVersion').mockRejectedValueOnce({ code: 'not_found', message: 'price version not found' });
    const { user, form } = await editProject(demoState(), 'Brand refresh');
    await user.click(removeButton(form, '2026-03-09'));
    await user.click(within(await dialogOf()).getByRole('button', { name: 'Remove price' }));
    expect(await within(form).findByTestId('project-error')).toHaveTextContent('price version not found');
    expect(removeButton(form, '2026-03-09')).toBeVisible();
  });

  it('shows no amount in the question while earnings are hidden', async () => {
    const s = demoState();
    s.hideEarnings = true;
    const { user, form } = await editProject(s, 'Brand refresh');
    await user.click(removeButton(form, '2026-03-09'));
    const ask = await dialogOf();
    expect(ask).not.toHaveTextContent(/[$€]|\b90(00)?\b/);
  });

  it('a version that no reader would take is listed and can be removed, as the sync warning says', async () => {
    const s = demoState();
    s.rates.push({ id: 'r-bad', projectId: 'p-web', effectiveFrom: '2150-01-01T00:00:00Z', rateCents: 6500, currency: 'EUR', deleted: false, stamp });
    const { user, form } = await editProject(s, 'Website');
    await user.click(removeButton(form, '2150-01-01'));
    await user.click(within(await dialogOf()).getByRole('button', { name: 'Remove price' }));
    await waitFor(() => expect(calls('delete_rate_version')).toEqual([{ id: 'r-bad', confirmRetroactive: true }]));
    await waitFor(() => expect(s.rates.find((r) => r.id === 'r-bad')?.deleted).toBe(true));
  });

  it('the From date of a price offers only the days the backend takes: min and max are set, and the refusal covers what is typed past them', async () => {
    const { user, form } = await editProject(demoState(), 'Website');
    await user.clear(box(form, 'Price'));
    await user.type(box(form, 'Price'), '65');
    await user.click(within(form).getByRole('radio', { name: 'Applies from a date' }));
    const date = within(form).getByLabelText('From date');
    expect(date).toHaveAttribute('min', '2000-01-01');
    expect(date).toHaveAttribute('max', '2100-01-01');
  });
});
