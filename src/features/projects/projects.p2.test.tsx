import { clearMocks } from '@tauri-apps/api/mocks';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { api } from '../../lib/api';
import { boot as bootApp, polyfillDom } from '../../components/testKit';
import { demoP2State, demoState } from '../../mocks/demoSeed';
import { fullProject } from '../../mocks/factories';
import type { MockState } from '../../mocks/ipcMock';
import type { BudgetStatus } from '../../lib/types';
import { BudgetMeter } from './BudgetMeter';

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
const boot = (s: MockState) => {
  state = s;
  return bootApp(s);
};
const calls = (cmd: string) => state.calls.filter((c) => c.cmd === cmd).map((c) => c.args as { input: Record<string, unknown> } & Record<string, unknown>);

async function openProjects(s: MockState) {
  const user = userEvent.setup();
  boot(s);
  await user.click(await screen.findByRole('tab', { name: 'Projects' }));
  return user;
}
async function newProject(s: MockState) {
  const user = await openProjects(s);
  await user.click(screen.getByRole('button', { name: 'New project' }));
  return { user, form: screen.getByRole('form', { name: 'New project' }) };
}
const rowOf = (name: string) => within(screen.getAllByRole('heading', { level: 3 }).find((h) => h.textContent === name)?.closest('li') as HTMLElement);

describe('project form: the colour picker', () => {
  it('sends any picked colour as lower-case #rrggbb and keeps it through the mock', async () => {
    const { user, form } = await newProject(demoState());
    await user.type(within(form).getByRole('textbox', { name: 'Project name' }), 'Retail');
    await user.clear(within(form).getByRole('textbox', { name: 'Hex' }));
    await user.type(within(form).getByRole('textbox', { name: 'Hex' }), '#ABCDEF');
    expect(within(form).getByRole('textbox', { name: 'Red' })).toHaveValue('171');
    await user.click(within(form).getByRole('button', { name: 'Create project' }));
    await waitFor(() => expect(calls('create_project')).toHaveLength(1));
    expect(calls('create_project')[0]?.input).toMatchObject({ name: 'Retail', color: '#abcdef', billingType: 'hourly' });
    expect(state.projects.find((p) => p.name === 'Retail')?.color).toBe('#abcdef');
    // Hourly projects send no fee at all.
    expect('fixedFeeCents' in (calls('create_project')[0]?.input ?? {})).toBe(false);
    expect('feeCurrency' in (calls('create_project')[0]?.input ?? {})).toBe(false);
  });

  it('remembers the colour on this device and offers it next time; a swatch click still works', async () => {
    const first = await newProject(demoState());
    await first.user.type(within(first.form).getByRole('textbox', { name: 'Project name' }), 'Retail');
    await first.user.clear(within(first.form).getByRole('textbox', { name: 'Hex' }));
    await first.user.type(within(first.form).getByRole('textbox', { name: 'Hex' }), '123abc');
    await first.user.click(within(first.form).getByRole('button', { name: 'Create project' }));
    await waitFor(() => expect(state.projects.some((p) => p.color === '#123abc')).toBe(true));
    expect(JSON.parse(window.localStorage.getItem('zwt.recentColors') ?? '[]')).toEqual(['#123abc']);
    await first.user.click(await screen.findByRole('button', { name: 'New project' }));
    const form = screen.getByRole('form', { name: 'New project' });
    await first.user.click(within(form).getByRole('button', { name: 'Recent colour #123abc' }));
    expect(within(form).getByRole('textbox', { name: 'Hex' })).toHaveValue('#123abc');
  });

  it('saves fine when storage is unavailable', async () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    const { user, form } = await newProject(demoState());
    await user.type(within(form).getByRole('textbox', { name: 'Project name' }), 'Retail');
    await user.click(within(form).getByRole('radio', { name: 'Colour #db2777' }));
    await user.click(within(form).getByRole('button', { name: 'Create project' }));
    await waitFor(() => expect(state.projects.find((p) => p.name === 'Retail')?.color).toBe('#db2777'));
  });

  it('warns about a colour close to another project, and still lets the project be saved', async () => {
    const { user, form } = await newProject(demoState());
    await user.type(within(form).getByRole('textbox', { name: 'Project name' }), 'Retail');
    await user.click(within(form).getByRole('radio', { name: 'Colour #2563eb' }));
    expect(within(form).getByTestId('cp-warn-similar')).toHaveTextContent('Close to Brand refresh (#2563eb)');
    await user.click(within(form).getByRole('button', { name: 'Create project' }));
    await waitFor(() => expect(state.projects.find((p) => p.name === 'Retail')?.color).toBe('#2563eb'));
  });

  it('shows a refusal about the colour beside the picker, as text, and one about anything else above the buttons', async () => {
    const { user, form } = await newProject(demoState());
    await user.type(within(form).getByRole('textbox', { name: 'Project name' }), 'Retail');
    const spy = vi.spyOn(api, 'createProject').mockRejectedValueOnce({ code: 'validation', message: 'a color must look like <b>#1a2b3c</b>' });
    await user.click(within(form).getByRole('button', { name: 'Create project' }));
    expect(await within(form).findByTestId('cp-error')).toHaveTextContent('a color must look like <b>#1a2b3c</b>');
    expect(form.querySelector('b')).toBeNull();
    expect(within(form).queryByTestId('project-error')).toBeNull();
    spy.mockRejectedValueOnce({ code: 'io', message: 'disk <i>full</i>' });
    await user.click(within(form).getByRole('button', { name: 'Create project' }));
    expect(await within(form).findByTestId('project-error')).toHaveTextContent('disk <i>full</i>');
    expect(form.querySelector('i')).toBeNull();
    expect(state.projects.some((p) => p.name === 'Retail')).toBe(false);
    // The form stays open with what was typed, so the user can fix it and retry.
    expect(within(form).getByRole('textbox', { name: 'Project name' })).toHaveValue('Retail');
  });
});

describe('project form: fixed fee', () => {
  it('offers Hourly or Fixed fee, shows the fee fields only for a fixed fee and explains the price per hour', async () => {
    const { user, form } = await newProject(demoState());
    expect(within(form).getByRole('radio', { name: 'Hourly' })).toBeChecked();
    expect(within(form).queryByRole('textbox', { name: 'Fee' })).toBeNull();
    await user.click(within(form).getByRole('radio', { name: 'Fixed fee' }));
    expect(within(form).getByRole('textbox', { name: 'Fee' })).toBeInTheDocument();
    expect(within(form).getByRole('combobox', { name: 'Fee currency' })).toHaveValue('EUR');
    expect(within(form).getByTestId('fixed-fee-yardstick')).toHaveTextContent('only as a yardstick');
    expect(within(form).getByTestId('needs-target-rate')).toHaveTextContent('A fixed fee needs a price per hour to measure your time against it');
    await user.type(within(form).getByRole('textbox', { name: 'Price' }), '50');
    expect(within(form).queryByTestId('needs-target-rate')).toBeNull();
  });

  it('requires the fee and checks its range before sending anything', async () => {
    const { user, form } = await newProject(demoState());
    await user.type(within(form).getByRole('textbox', { name: 'Project name' }), 'Print');
    await user.click(within(form).getByRole('radio', { name: 'Fixed fee' }));
    await user.click(within(form).getByRole('button', { name: 'Create project' }));
    expect(await within(form).findByText('Enter the fixed fee, like 1000 or 1000.50.')).toBeVisible();
    for (const bad of ['abc', '12.345', '-5', '10000000001']) {
      await user.clear(within(form).getByRole('textbox', { name: 'Fee' }));
      await user.type(within(form).getByRole('textbox', { name: 'Fee' }), bad);
      await user.click(within(form).getByRole('button', { name: 'Create project' }));
      expect(within(form).getByRole('textbox', { name: 'Fee' })).toHaveAttribute('aria-invalid', 'true');
    }
    expect(calls('create_project')).toEqual([]);
  });

  it('sends billingType, fixedFeeCents and feeCurrency, and sets the price per hour in the fee currency', async () => {
    const { user, form } = await newProject(demoState());
    await user.type(within(form).getByRole('textbox', { name: 'Project name' }), 'Print');
    await user.click(within(form).getByRole('radio', { name: 'Fixed fee' }));
    await user.type(within(form).getByRole('textbox', { name: 'Fee' }), '1000.50');
    await user.selectOptions(within(form).getByRole('combobox', { name: 'Fee currency' }), 'USD');
    await user.type(within(form).getByRole('textbox', { name: 'Price' }), '40');
    await user.click(within(form).getByRole('button', { name: 'Create project' }));
    await waitFor(() => expect(calls('create_project')).toHaveLength(1));
    expect(calls('create_project')[0]?.input).toMatchObject({ name: 'Print', billable: true, billingType: 'fixedFee', fixedFeeCents: 100_050, feeCurrency: 'USD' });
    await waitFor(() => expect(calls('set_rate')).toHaveLength(1));
    expect(calls('set_rate')[0]?.input).toMatchObject({ rateCents: 4000, currency: 'USD' });
    const p = state.projects.find((x) => x.name === 'Print');
    expect([p?.billingType, p?.fixedFeeCents, p?.feeCurrency]).toEqual(['fixedFee', 100_050, 'USD']);
  });

  it('allows a fee of 0', async () => {
    const { user, form } = await newProject(demoState());
    await user.type(within(form).getByRole('textbox', { name: 'Project name' }), 'Free');
    await user.click(within(form).getByRole('radio', { name: 'Fixed fee' }));
    await user.type(within(form).getByRole('textbox', { name: 'Fee' }), '0');
    await user.click(within(form).getByRole('button', { name: 'Create project' }));
    await waitFor(() => expect(calls('create_project')[0]?.input).toMatchObject({ fixedFeeCents: 0, billingType: 'fixedFee' }));
  });

  it('editing a fixed-fee project shows its fee and switching back to hourly sends no fee', async () => {
    const user = await openProjects(demoP2State());
    await user.click(await screen.findByRole('button', { name: 'Edit Print run (fixed fee)' }));
    const form = screen.getByRole('form', { name: 'Edit project Print run (fixed fee)' });
    expect(within(form).getByRole('radio', { name: 'Fixed fee' })).toBeChecked();
    expect(within(form).getByRole('textbox', { name: 'Fee' })).toHaveValue('1000');
    expect(within(form).getByRole('textbox', { name: 'Price' })).toHaveValue('50');
    await user.click(within(form).getByRole('radio', { name: 'Hourly' }));
    await user.click(within(form).getByRole('button', { name: 'Save project' }));
    await waitFor(() => expect(calls('update_project')).toHaveLength(1));
    const input = calls('update_project')[0]?.input ?? {};
    expect(input.billingType).toBe('hourly');
    expect('fixedFeeCents' in input).toBe(false);
    const p = state.projects.find((x) => x.id === 'p-print');
    expect([p?.billingType, p?.fixedFeeCents, p?.feeCurrency]).toEqual(['hourly', null, null]);
  });
});

describe('projects tab: fixed fee and budget', () => {
  it('shows the fee instead of "No rate set", the effective hourly rate, and the budget at 86 percent', async () => {
    await openProjects(demoP2State());
    const row = rowOf('Print run (fixed fee)');
    expect(row.getByText('Fixed fee €1,000.00')).toBeVisible();
    expect(row.queryByText(/No rate set/)).toBeNull();
    expect(row.getByText(/Effective hourly rate €\d+\.\d\d\/h/)).toBeVisible();
    expect(row.getByText('Measured at €50.00/h')).toBeVisible();
    const budget = row.getByTestId('budget');
    expect(budget).toHaveAttribute('data-level', '80');
    expect(budget).toHaveTextContent('86% of the fixed fee');
    expect(budget).toHaveTextContent('80% warning');
    expect(row.getByRole('meter', { name: 'Budget used, Print run (fixed fee)' })).toHaveAttribute('aria-valuetext', '86% of the fixed fee, 80% warning');
  });

  it('hides the fee, the effective rate and the percent of a fee while earnings are hidden', async () => {
    const s = demoP2State();
    s.hideEarnings = true;
    await openProjects(s);
    const row = rowOf('Print run (fixed fee)');
    expect(row.getByText('Fixed fee ••••')).toBeVisible();
    expect(row.getByText(/Effective hourly rate ••••\/h/)).toBeVisible();
    expect(row.getByText('Measured at ••••/h')).toBeVisible();
    expect(row.getByTestId('budget')).toHaveTextContent('•••• of the fixed fee');
    expect(row.getByTestId('budget')).toHaveTextContent('80% warning');
    expect(row.queryByRole('meter')).toBeNull();
    expect(row.queryByText(/€/)).toBeNull();
    expect(row.queryByText(/86/)).toBeNull();
    // An hours budget is not money, so its percent stays.
    expect(rowOf('Brand refresh').getByTestId('budget')).toHaveTextContent(/\d+% of 60 h/);
  });

  it('explains that a fixed fee needs a price per hour, and offers to set one', async () => {
    const s = demoP2State();
    s.rates = s.rates.filter((r) => r.projectId !== 'p-print');
    const user = await openProjects(s);
    const row = rowOf('Print run (fixed fee)');
    expect(row.getByTestId('budget-need')).toHaveTextContent('A fixed fee needs a price per hour to measure your time against it');
    expect(row.queryByRole('meter')).toBeNull();
    await user.click(row.getByRole('button', { name: /Set a price per hour/ }));
    const form = await screen.findByRole('form', { name: 'Edit project Print run (fixed fee)' });
    expect(within(form).getByTestId('needs-target-rate')).toBeVisible();
  });

  it('shows the hours budget with its basis for a normal project', async () => {
    await openProjects(demoP2State());
    const budget = rowOf('Website').getByTestId('budget');
    expect(budget).toHaveTextContent(/\d+% of 40 h/);
    expect(rowOf('Packaging').queryByTestId('budget')).toBeNull();
  });
});

describe('BudgetMeter levels', () => {
  const meter = (budget: BudgetStatus | null, extra: Partial<Parameters<typeof fullProject>[0]> = {}) =>
    render(<BudgetMeter project={fullProject({ id: 'p', name: 'Proj', budgetHours: 60, figures: { exactSecs: 0, pauseSecs: 0, billableSecs: 0, thinkingSecs: 0, effectiveHourlyCents: null, timeValueCents: {}, budget }, ...extra })} hideEarnings={false} />);

  it('level 0: percent and basis, no alert words', () => {
    meter({ basis: 'hours', percent: 12, level: 0, needsTargetRate: false });
    expect(screen.getByTestId('budget')).toHaveTextContent('12% of 60 h');
    expect(screen.queryByText(/warning|over/)).toBeNull();
    expect(screen.getByRole('meter')).toHaveAttribute('aria-valuenow', '12');
  });

  it('level 80: "80% warning" in words', () => {
    meter({ basis: 'hours', percent: 80, level: 80, needsTargetRate: false });
    expect(screen.getByTestId('budget')).toHaveTextContent('80% of 60 h');
    expect(screen.getByText('80% warning')).toBeVisible();
  });

  it('level 100: "100% over", and the bar never exceeds its track although the percent is shown in full', () => {
    meter({ basis: 'hours', percent: 130, level: 100, needsTargetRate: false });
    expect(screen.getByTestId('budget')).toHaveTextContent('130% of 60 h');
    expect(screen.getByText('100% over')).toBeVisible();
    expect(screen.getByRole('meter')).toHaveAttribute('aria-valuenow', '100');
  });

  it('needs a target rate: only the explanation, no bar', () => {
    meter({ basis: 'fee', percent: 0, level: 0, needsTargetRate: true });
    expect(screen.getByTestId('budget-need')).toHaveTextContent('A fixed fee needs a price per hour to measure your time against it');
    expect(screen.queryByRole('meter')).toBeNull();
  });

  it('no budget, no element', () => {
    const { container } = meter(null);
    expect(container).toBeEmptyDOMElement();
  });
});
