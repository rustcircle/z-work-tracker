// Time away needs an answer that is written to the shared data, so the dialog that asks stays closed while another computer holds
// the lease, and asks once this one may write.
import { emit } from '@tauri-apps/api/event';
import { clearMocks } from '@tauri-apps/api/mocks';
import { act, cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { readOnlyMessage } from '../../app/useReadOnly';
import { boot as bootApp, polyfillDom } from '../../components/testKit';
import { api } from '../../lib/api';
import { demoP2State } from '../../mocks/demoSeed';
import { leaseView, loseLease, seedLease, type LeaseSeed, type MockState } from '../../mocks/ipcMock';

const WHY = readOnlyMessage('LAPTOP');

let state: MockState;
beforeEach(polyfillDom);
afterEach(() => {
  cleanup();
  clearMocks();
});

const calls = (cmd: string) => state.calls.filter((c) => c.cmd === cmd).map((c) => c.args as Record<string, unknown>);
const dialog = () => screen.queryByRole('dialog', { name: /You were away/ });
const arrives = (change: () => unknown) =>
  act(async () => {
    await change();
    await emit('state-changed');
  });
const takeOver = () => {
  const holder = leaseView(state).holder;
  if (!holder) throw new Error('nobody holds the lease');
  return api.leaseTakeOver({ generation: holder.generation, beatSeq: holder.beatSeq }, 'live');
};

function boot(lease: LeaseSeed) {
  state = demoP2State();
  seedLease(state, lease);
  return bootApp(state);
}

describe('the time away dialog', () => {
  it('stays closed at start-up while read-only, and the banner can not open it, saying why', async () => {
    const user = userEvent.setup();
    boot('live');
    const banner = await screen.findByTestId('away-banner');
    const review = within(banner).getByRole('button', { name: 'Review time away' });
    expect(review).toBeDisabled();
    expect(review).toHaveAttribute('title', WHY);
    await user.click(review);
    // Give it every chance to open.
    await new Promise((r) => setTimeout(r, 300));
    expect(dialog()).toBeNull();
    expect(calls('decide_gap')).toEqual([]);
  });

  it('asks by itself once this computer takes over, since it was never asked about this time', async () => {
    boot('live');
    await screen.findByTestId('away-banner');
    expect(dialog()).toBeNull();
    await arrives(takeOver);
    expect(await screen.findByRole('dialog', { name: /You were away/ })).toBeVisible();
    expect(within(screen.getByTestId('away-banner')).getByRole('button', { name: 'Review time away' })).toBeEnabled();
  });

  it('closes when the lease goes while it is open, and the banner stays', async () => {
    boot('mine');
    const open = await screen.findByRole('dialog', { name: /You were away/ });
    await arrives(() => loseLease(state));
    await waitFor(() => expect(open).not.toBeInTheDocument());
    expect(screen.getByTestId('away-banner')).toBeVisible();
    expect(within(screen.getByTestId('away-banner')).getByRole('button', { name: 'Review time away' })).toBeDisabled();
  });

  it('opens by itself where this computer may write, as it always did', async () => {
    boot('mine');
    expect(await screen.findByRole('dialog', { name: /You were away/ })).toBeVisible();
  });
});
