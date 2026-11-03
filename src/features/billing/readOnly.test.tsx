// Billing while another computer holds the lease: summaries can't be made or voided, and what only reads or exports still works.
import { emit } from '@tauri-apps/api/event';
import { clearMocks } from '@tauri-apps/api/mocks';
import { act, cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { readOnlyMessage } from '../../app/useReadOnly';
import { boot as bootApp, polyfillDom } from '../../components/testKit';
import { demoP2State } from '../../mocks/demoSeed';
import { loseLease, seedLease, type LeaseSeed, type MockState } from '../../mocks/ipcMock';

const WHY = readOnlyMessage('LAPTOP');

let state: MockState;
beforeEach(polyfillDom);
afterEach(() => {
  cleanup();
  clearMocks();
});

const calls = (cmd: string) => state.calls.filter((c) => c.cmd === cmd).map((c) => c.args as Record<string, unknown>);
const card = (name: string) => within(screen.getByRole('region', { name }));

async function openBilling(lease: LeaseSeed) {
  state = demoP2State();
  seedLease(state, lease);
  const user = userEvent.setup();
  bootApp(state);
  // Time away waits for an answer in this demo: it asks by itself only where this computer may write.
  if (lease === 'mine') {
    const away = await screen.findByRole('dialog', { name: /You were away/ });
    await user.keyboard('{Escape}');
    await waitFor(() => expect(away).not.toBeInTheDocument());
  }
  await user.click(await screen.findByRole('tab', { name: 'Billing' }));
  const unbilled = card('Unbilled time');
  await waitFor(() => expect(unbilled.getByRole('table')).toBeVisible());
  return { user, unbilled };
}

describe('the Billing tab', () => {
  it('Create summary is off with the reason beside it, and Copy still works', async () => {
    const { user, unbilled } = await openBilling('live');
    const create = unbilled.getByRole('button', { name: 'Create summary' });
    expect(create).toBeDisabled();
    expect(create).toHaveAttribute('title', WHY);
    expect(create).toHaveAccessibleDescription(`${WHY} Copy still works.`);
    expect(unbilled.getByRole('button', { name: 'Copy' })).toBeEnabled();
    await user.click(create);
    expect(calls('create_summary')).toEqual([]);
  });

  it('Void is off on a live summary, Copy and Export CSV are not', async () => {
    const { user } = await openBilling('live');
    const summaries = card('Summaries');
    const live = within(summaries.getByRole('listitem', { name: 'A-001, live' }));
    expect(live.getByRole('button', { name: 'Void A-001' })).toBeDisabled();
    expect(live.getByRole('button', { name: 'Void A-001' })).toHaveAttribute('title', WHY);
    expect(live.getByRole('button', { name: 'Copy A-001' })).toBeEnabled();
    expect(live.getByRole('button', { name: 'Export CSV for A-001' })).toBeEnabled();
    await user.click(live.getByRole('button', { name: 'Export CSV for A-001' }));
    await waitFor(() => expect(calls('export_summary_csv')).toHaveLength(1));
    expect(calls('void_summary')).toEqual([]);
  });

  it('is as it always was where this computer may write', async () => {
    const { unbilled } = await openBilling('mine');
    expect(unbilled.getByRole('button', { name: 'Create summary' })).toBeEnabled();
    expect(unbilled.getByRole('button', { name: 'Create summary' })).not.toHaveAttribute('title');
    expect(card('Summaries').getByRole('button', { name: 'Void A-001' })).toBeEnabled();
  });

  it('a void dialog already open says why once the lease goes', async () => {
    const { user } = await openBilling('mine');
    await user.click(card('Summaries').getByRole('button', { name: 'Void A-001' }));
    const dialog = await screen.findByRole('dialog', { name: 'Void A-001?' });
    expect(within(dialog).queryByText(WHY)).toBeNull();
    await act(async () => {
      loseLease(state);
      await emit('state-changed');
    });
    await waitFor(() => expect(within(dialog).getByText(WHY)).toBeVisible());
    // The dialog can still be left; pressing the button would only bring the backend's refusal into it.
    expect(within(dialog).getByRole('button', { name: 'Cancel' })).toBeEnabled();
    await user.click(within(dialog).getByRole('button', { name: 'Void summary' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(WHY);
    expect(state.summaries.find((b) => b.reference === 'A-001')?.voided).toBe(false);
  });
});
