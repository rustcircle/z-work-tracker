import { clearMocks } from '@tauri-apps/api/mocks';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { boot as bootApp, polyfillDom } from '../../components/testKit';
import { api } from '../../lib/api';
import type { PdfRequest } from '../../lib/types';
import { demoP2State } from '../../mocks/demoSeed';
import type { MockState } from '../../mocks/ipcMock';
import { GUIDANCE } from './billingText';

beforeEach(polyfillDom);
afterEach(() => {
  clearMocks();
  vi.restoreAllMocks();
});

let state: MockState;
const boot = (s: MockState) => {
  state = s;
  return bootApp(s);
};
const calls = (cmd: string) => state.calls.filter((c) => c.cmd === cmd).map((c) => c.args as Record<string, unknown>);
type User = ReturnType<typeof userEvent.setup>;
const go = async (user: User, tab: string) => user.click(await screen.findByRole('tab', { name: tab }));
const card = (name: string) => within(screen.getByRole('region', { name }));

async function openBilling(user: User, s = demoP2State()) {
  boot(s);
  await go(user, 'Billing');
  const unbilled = card('Unbilled time');
  await waitFor(() => expect(unbilled.getByRole('table')).toBeVisible());
  return unbilled;
}

describe('billing tab', () => {
  it('carries the guidance label at the top and in every card', async () => {
    const user = userEvent.setup();
    await openBilling(user);
    expect(screen.getAllByText(GUIDANCE).length).toBeGreaterThanOrEqual(4);
    for (const name of ['Unbilled time', 'Summaries', 'Quote helper']) expect(card(name).getByText(GUIDANCE)).toBeVisible();
  });

  it('defaults to the project with the most unbilled time and its client zone, and previews with its pause', async () => {
    const user = userEvent.setup();
    const unbilled = await openBilling(user);
    expect(unbilled.getByLabelText('Project')).toHaveValue('p-brand');
    expect(unbilled.getByLabelText('Days are cut in')).toHaveValue('America/New_York');
    expect(calls('summary_preview').at(-1)).toMatchObject({ request: { projectId: 'p-brand', from: '2026-03-01', to: '2026-03-31', zone: 'America/New_York' } });
    expect(unbilled.getAllByText('includes 30m billable pauses')).toHaveLength(2); // the row and the total
    expect(unbilled.getByText(/A running segment is not included/)).toBeVisible();
  });

  it('creates a summary with the next number, shows it first, and the time is no longer unbilled', async () => {
    const user = userEvent.setup();
    const unbilled = await openBilling(user);
    await user.selectOptions(unbilled.getByLabelText('Project'), 'p-web');
    await waitFor(() => expect(unbilled.getByTestId('billing-total-amount')).toHaveTextContent('€1,125.00'));
    await user.click(unbilled.getByRole('button', { name: 'Create summary' }));
    expect(await unbilled.findByTestId('billing-created')).toHaveTextContent('Created A-003');
    expect(calls('create_summary')).toEqual([{ request: { projectId: 'p-web', from: '2026-03-01', to: '2026-03-31', zone: 'Europe/Lisbon' } }]);
    await waitFor(() => expect(unbilled.getByText('There is no unbilled time in that period.')).toBeVisible());
    expect(unbilled.getByRole('button', { name: 'Create summary' })).toBeDisabled();
    const items = card('Summaries').getAllByRole('listitem');
    expect(items[0]).toHaveAccessibleName('A-003, live');
    expect(state.summaries.at(-1)).toMatchObject({ reference: 'A-003', voided: false });
  });

  it('shows the backend refusal inline when creating fails', async () => {
    const user = userEvent.setup();
    const unbilled = await openBilling(user);
    state.failNext = ['create_summary'];
    await user.click(unbilled.getByRole('button', { name: 'Create summary' }));
    expect(await unbilled.findByRole('alert')).toHaveTextContent('create_summary failed');
    expect(state.summaries).toHaveLength(2);
  });

  it('says a fixed-fee project has no hourly amount and shows the fee, masked by Hide earnings', async () => {
    const user = userEvent.setup();
    const s = demoP2State();
    boot(s);
    await go(user, 'Billing');
    const unbilled = card('Unbilled time');
    await waitFor(() => expect(unbilled.getByRole('table')).toBeVisible());
    await user.selectOptions(unbilled.getByLabelText('Project'), 'p-print');
    const note = await unbilled.findByTestId('billing-fixed-fee');
    expect(note).toHaveTextContent('Fixed fee: no hourly amount');
    expect(note).toHaveTextContent('€1,000.00');
    await user.click(screen.getByRole('button', { name: 'Hide earnings' }));
    await waitFor(() => expect(unbilled.getByTestId('billing-fixed-fee')).toHaveTextContent('••••'));
    expect(unbilled.getByTestId('billing-fixed-fee')).not.toHaveTextContent('€');
  });
});

describe('copy', () => {
  it('writes the plain text to the clipboard and confirms it', async () => {
    const user = userEvent.setup();
    const unbilled = await openBilling(user);
    await user.click(unbilled.getByRole('button', { name: 'Copy' }));
    expect(await unbilled.findByText('Copied to the clipboard.')).toBeVisible();
    const text = await navigator.clipboard.readText();
    expect(text.split('\n')[0]).toBe(GUIDANCE);
    expect(text).toContain('Project: Brand refresh');
    expect(text).toContain('A running segment is not included.');
  });

  it('shows the text selected in a box when the clipboard refuses', async () => {
    const user = userEvent.setup();
    const unbilled = await openBilling(user);
    vi.spyOn(navigator.clipboard, 'writeText').mockRejectedValue(new Error('denied'));
    await user.click(unbilled.getByRole('button', { name: 'Copy' }));
    expect(await unbilled.findByText(/Copying is not available here/)).toBeVisible();
    const box = unbilled.getByRole('textbox', { name: 'Text to copy' });
    expect((box as HTMLTextAreaElement).value.startsWith(GUIDANCE)).toBe(true);
    expect(box).toHaveFocus();
  });

  it('shows the text when there is no clipboard at all', async () => {
    const user = userEvent.setup();
    const unbilled = await openBilling(user);
    Object.defineProperty(navigator, 'clipboard', { value: undefined, configurable: true });
    await user.click(unbilled.getByRole('button', { name: 'Copy' }));
    expect(await unbilled.findByRole('textbox', { name: 'Text to copy' })).toBeVisible();
  });
});

describe('summaries', () => {
  it('voids only after the confirmation, which says the time returns and the number is not reused', async () => {
    const user = userEvent.setup();
    await openBilling(user);
    const a1 = within(screen.getByRole('listitem', { name: 'A-001, live' }));
    await user.click(a1.getByRole('button', { name: 'Void A-001' }));
    const dialog = within(await screen.findByRole('dialog', { name: 'Void A-001?' }));
    expect(dialog.getByText(/returns to unbilled/)).toBeVisible();
    expect(dialog.getByText(/is not reused/)).toBeVisible();
    await user.click(dialog.getByRole('button', { name: 'Cancel' }));
    expect(calls('void_summary')).toEqual([]);
    expect(screen.getByRole('button', { name: 'Void A-001' })).toHaveFocus();

    await user.click(screen.getByRole('button', { name: 'Void A-001' }));
    await user.click(within(await screen.findByRole('dialog', { name: 'Void A-001?' })).getByRole('button', { name: 'Void summary' }));
    await waitFor(() => expect(calls('void_summary')).toEqual([{ id: 'summary-1002' }]));
    expect(await screen.findByRole('listitem', { name: 'A-001, voided' })).toHaveFocus();
    expect(screen.queryByRole('button', { name: 'Void A-001' })).toBeNull();
  });

  it('exports a CSV for the summary and shows the path, or that it was cancelled', async () => {
    const user = userEvent.setup();
    await openBilling(user);
    const a1 = within(screen.getByRole('listitem', { name: 'A-001, live' }));
    await user.click(a1.getByRole('button', { name: 'Export CSV for A-001' }));
    expect(await a1.findByText('Saved to /mock/A-001.csv')).toBeVisible();
    vi.spyOn(api, 'exportSummaryCsv').mockResolvedValue(null);
    await user.click(a1.getByRole('button', { name: 'Export CSV for A-001' }));
    expect(await a1.findByText('Cancelled. Nothing was saved.')).toBeVisible();
  });

  it('masks amounts with Hide earnings and still shows hours', async () => {
    const user = userEvent.setup();
    const s = demoP2State();
    s.hideEarnings = true;
    boot(s);
    await go(user, 'Billing');
    const a1 = await screen.findByRole('listitem', { name: 'A-001, live' });
    expect(a1).toHaveTextContent('Billable 12h 30m');
    expect(a1).toHaveTextContent('Amount ••••');
    expect(screen.getByRole('region', { name: 'Billing' })).not.toHaveTextContent(/[$€]\d/);
  });
});

describe('quote helper', () => {
  const mkTask = (i: number, hours: number): void => {
    state.tasks.push({ id: `tq${i}`, name: `Poster ${['concepts', 'draft', 'revision', 'final'][i]}`, projectId: 'p-brand', description: null, state: 'stopped', pauseReason: null, createdAt: '2026-02-01T00:00:00Z', stoppedAt: `2026-02-${10 + i}T18:00:00Z`, runningElsewhere: null, continuedFrom: null, tags: [] });
    const day = `2026-02-${10 + i}`;
    state.segments.push({ id: `sq${i}`, taskId: `tq${i}`, deviceId: '11111111-1111-4111-8111-111111111111', start: `${day}T09:00:00Z`, end: new Date(Date.parse(`${day}T09:00:00Z`) + hours * 3_600_000).toISOString().slice(0, 19) + 'Z', provisionalEnd: null });
  };

  it('says Not enough data below 3 comparable tasks, and still labels it Estimate', async () => {
    const user = userEvent.setup();
    boot(demoP2State());
    await go(user, 'Billing');
    const q = card('Quote helper');
    await user.type(q.getByLabelText('Job name'), 'Homepage layout');
    expect(await q.findByTestId('quote-not-enough')).toHaveTextContent('Not enough data');
    expect(q.getByText('Estimate')).toBeVisible();
    expect(q.getByRole('list', { name: 'Comparable tasks' })).toHaveTextContent('Homepage layout');
  });

  it('with four comparable tasks shows hours and an amount range at the project rate; Hide earnings masks only the amount', async () => {
    const user = userEvent.setup();
    const s = demoP2State();
    state = s;
    [1, 2, 3, 4].forEach((h, i) => mkTask(i, h));
    boot(s);
    await go(user, 'Billing');
    const q = card('Quote helper');
    await user.type(q.getByLabelText('Job name'), 'Poster');
    await user.selectOptions(q.getByLabelText('Project (optional)'), 'p-brand');
    await waitFor(() => expect(q.getByTestId('quote-sample')).toHaveTextContent('Based on 4 comparable tasks.'));
    expect(q.getAllByText('Range')[0]?.parentElement).toHaveTextContent('1h 00m to 4h 00m');
    expect(q.getByTestId('quote-amount')).toHaveTextContent('$225.00');
    expect(q.getByTestId('quote-amount')).toHaveTextContent('$90.00/h');
    await user.click(screen.getByRole('button', { name: 'Hide earnings' }));
    await waitFor(() => expect(q.getByTestId('quote-amount')).toHaveTextContent('••••'));
    expect(q.getByTestId('quote-amount')).not.toHaveTextContent(/[$€]\d/);
    expect(q.getAllByText(/1h 00m to 4h 00m/).length).toBeGreaterThan(0);
  });
});

describe('device prefix', () => {
  it('saves in capitals, shows the next reference, and the backend refusal otherwise', async () => {
    const user = userEvent.setup();
    boot(demoP2State());
    await go(user, 'Settings');
    const section = card('Billing references');
    const input = section.getByLabelText('Prefix of this device');
    expect(input).toHaveValue('A');
    expect(section.getByTestId('next-reference')).toHaveTextContent('A-003');
    await user.clear(input);
    await user.type(input, 'pc2');
    expect(input).toHaveValue('PC2');
    expect(section.getByTestId('next-reference')).toHaveTextContent('PC2-001');
    await user.click(section.getByRole('button', { name: 'Save prefix' }));
    await waitFor(() => expect(calls('set_device_prefix')).toEqual([{ prefix: 'PC2' }]));
    expect(await section.findByText('Prefix saved: PC2.')).toBeVisible();
    expect(state.prefix).toBe('PC2');

    await user.clear(input);
    await user.type(input, 'toolong');
    await user.click(section.getByRole('button', { name: 'Save prefix' }));
    expect(await section.findByRole('alert')).toHaveTextContent('a prefix is 1 to 4 letters or digits');
    expect(state.prefix).toBe('PC2');
  });

  it('lists the other devices that use the same prefix', async () => {
    const user = userEvent.setup();
    const s = demoP2State();
    s.prefixClashes = ['Office PC'];
    boot(s);
    await go(user, 'Settings');
    const clash = card('Billing references').getByTestId('prefix-clash');
    expect(clash).toHaveTextContent('another device uses the same prefix');
    expect(within(clash).getByRole('listitem')).toHaveTextContent('Office PC');
  });
});

describe('PDF timesheet', () => {
  const requests = (): PdfRequest[] => calls('export_pdf').map((c) => c.request as PdfRequest);

  async function openPdf(user: User, s = demoP2State()) {
    boot(s);
    await user.click(await screen.findByRole('button', { name: 'Export' }));
    const dialog = within(await screen.findByRole('dialog', { name: 'Export' }));
    await user.click(dialog.getByRole('radio', { name: 'PDF timesheet (.pdf)' }));
    return dialog;
  }

  it('sends prices by default, and not when Hide earnings is on unless turned on', async () => {
    const user = userEvent.setup();
    const dialog = await openPdf(user);
    await user.selectOptions(dialog.getByLabelText('Project'), 'p-brand');
    await user.click(dialog.getByRole('button', { name: 'Export PDF' }));
    await waitFor(() => expect(requests()).toHaveLength(1));
    expect(requests()[0]).toEqual({ projectId: 'p-brand', from: '2026-03-01', to: '2026-03-31', zone: 'America/New_York', title: 'Timesheet: Brand refresh', includePrices: true, useLogo: false });
  });

  it('Hide earnings: off by default, a visible note when switched on, and the request follows', async () => {
    const user = userEvent.setup();
    const s = demoP2State();
    s.hideEarnings = true;
    const dialog = await openPdf(user, s);
    const prices = dialog.getByRole('switch', { name: 'Include prices' });
    expect(prices).not.toBeChecked();
    expect(dialog.queryByTestId('pdf-prices-note')).toBeNull();
    await user.click(dialog.getByRole('button', { name: 'Export PDF' }));
    await waitFor(() => expect(requests()).toHaveLength(1));
    expect(requests()[0]?.includePrices).toBe(false);
    await user.click(prices);
    expect(dialog.getByTestId('pdf-prices-note')).toBeVisible();
    await user.click(dialog.getByRole('button', { name: 'Export PDF' }));
    await waitFor(() => expect(requests()).toHaveLength(2));
    expect(requests()[1]?.includePrices).toBe(true);
  });

  it('chooses and removes a logo, and asks for it only while saved', async () => {
    const user = userEvent.setup();
    const dialog = await openPdf(user);
    expect(dialog.getByRole('button', { name: 'Remove logo' })).toBeDisabled();
    await user.click(dialog.getByRole('button', { name: 'Choose logo' }));
    await waitFor(() => expect(state.hasPdfLogo).toBe(true));
    await waitFor(() => expect(dialog.getByRole('switch', { name: 'Print the logo' })).toBeChecked());
    await user.click(dialog.getByRole('button', { name: 'Export PDF' }));
    await user.click(dialog.getByRole('button', { name: 'Remove logo' }));
    await waitFor(() => expect(state.hasPdfLogo).toBe(false));
    await user.click(dialog.getByRole('button', { name: 'Export PDF' }));
    await waitFor(() => expect(requests()).toHaveLength(2));
    expect(requests().map((r) => r.useLogo)).toEqual([true, false]);
  });

  it('says the character limit, shows the saved path, and Cancelled for a cancelled save', async () => {
    const user = userEvent.setup();
    const dialog = await openPdf(user);
    expect(dialog.getByText('Text outside Western European characters prints as ?')).toBeVisible();
    await user.click(dialog.getByRole('button', { name: 'Export PDF' }));
    expect(await dialog.findByTestId('pdf-result')).toHaveTextContent('Saved to /mock/timesheet-2026-03-01-to-2026-03-31.pdf');
    vi.spyOn(api, 'exportPdf').mockResolvedValue(null);
    await user.click(dialog.getByRole('button', { name: 'Export PDF' }));
    await waitFor(() => expect(dialog.getByTestId('pdf-result')).toHaveTextContent(/^Cancelled$/));
  });
});
