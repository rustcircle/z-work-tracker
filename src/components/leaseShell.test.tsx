// The lease in the whole app: the line sits in the banners under the header on every tab, the take over works from there, and the one-time
// client zone question waits while this computer is read-only, because answering it means writing the zone.
import { emit } from '@tauri-apps/api/event';
import { clearMocks } from '@tauri-apps/api/mocks';
import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { toIso } from '../lib/tz';
import { demoState } from '../mocks/demoSeed';
import { loseLease, seedLease, type MockState } from '../mocks/ipcMock';
import { boot, polyfillDom } from './testKit';

beforeEach(polyfillDom);
afterEach(() => clearMocks());

const ASK = 'Do you work with a client in another time zone?';
const asking = () => screen.queryByRole('dialog', { name: ASK });

/** Someone who has not answered the client zone question yet. */
function unanswered(s: MockState): MockState {
  delete s.settings.clientZone;
  s.clientZonePromptDone = false;
  return s;
}

/** The computer that holds the lease says nothing for 20 minutes, which is when it looks inactive and take over is offered for it. */
async function goesQuiet(s: MockState): Promise<void> {
  await act(async () => {
    if (s.lease.holder) s.lease = { ...s.lease, state: 'heldByOtherStale', holder: { ...s.lease.holder, lastSignAt: toIso(s.now - 20 * 60) } };
    await emit('state-changed');
  });
}

async function takeOver(u: ReturnType<typeof userEvent.setup>): Promise<void> {
  await u.click(await screen.findByRole('button', { name: 'Take over…' }));
  const first = await screen.findByRole('dialog', { name: /^Take over from/ });
  await waitFor(() => expect(within(first).getByRole('button', { name: 'Continue' })).toBeEnabled());
  await u.click(within(first).getByRole('button', { name: 'Continue' }));
  await u.click(within(await screen.findByRole('dialog', { name: 'Are you sure?' })).getByRole('button', { name: 'Take over' }));
  await waitFor(() => expect(screen.queryByRole('dialog', { name: /Take over from|Are you sure/ })).toBeNull());
}

describe('the line in the app', () => {
  it('is in the banners above the tabs while another computer holds the lease, and the app is there under it', async () => {
    const s = demoState();
    seedLease(s, 'live');
    boot(s);
    const line = await screen.findByTestId('lease-banner');
    expect(line.parentElement).toHaveClass('banners');
    const tabs = screen.getByRole('tablist', { name: 'Sections' });
    expect(line.compareDocumentPosition(tabs) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(within(line).getByText('Read-only.')).toBeVisible();
    // Take over is offered once the other computer looks inactive, not while it looks in use.
    expect(within(line).getAllByRole('button').map((b) => b.textContent)).toEqual(['Check again']);
    // It stays on every tab.
    await userEvent.setup().click(screen.getByRole('tab', { name: 'Billing' }));
    expect(screen.getByTestId('lease-banner')).toBeVisible();
  });

  it('is not there with no folder, or when nobody holds it', async () => {
    boot(demoState());
    await screen.findByRole('tablist', { name: 'Sections' });
    expect(screen.queryByTestId('lease-banner')).toBeNull();
  });

  it('goes away when this computer takes over, and the backend tells what it closed', async () => {
    const s = demoState();
    seedLease(s, 'stale');
    boot(s);
    const u = userEvent.setup();
    await screen.findByTestId('lease-banner');
    await takeOver(u);
    await waitFor(() => expect(screen.queryByTestId('lease-banner')).toBeNull());
    expect(await screen.findByText('You took over from LAPTOP.')).toBeVisible();
  });

  it('comes back when another computer takes the lease while this one holds it', async () => {
    const s = demoState();
    seedLease(s, 'mine');
    boot(s);
    await screen.findByRole('tablist', { name: 'Sections' });
    expect(screen.queryByTestId('lease-banner')).toBeNull();
    await act(async () => {
      loseLease(s, { deviceName: 'Home PC' });
      await emit('state-changed');
    });
    const line = await screen.findByTestId('lease-banner');
    expect(line).toHaveTextContent('Home PC is using zWorkTracker');
  });
});

describe('the client zone question', () => {
  it('is asked when this computer can write', async () => {
    const s = unanswered(demoState());
    seedLease(s, 'free');
    boot(s);
    expect(await screen.findByRole('dialog', { name: ASK })).toBeVisible();
  });

  it('waits while this computer is read-only, and is asked after taking over', async () => {
    const s = unanswered(demoState());
    seedLease(s, 'stale');
    boot(s);
    const u = userEvent.setup();
    await screen.findByTestId('lease-banner');
    expect(asking()).toBeNull();
    await takeOver(u);
    expect(await screen.findByRole('dialog', { name: ASK })).toBeVisible();
  });

  it('is asked from the start again when the other computer takes over in the middle of choosing a zone', async () => {
    const s = unanswered(demoState());
    seedLease(s, 'mine');
    boot(s);
    const u = userEvent.setup();
    await u.click(within(await screen.findByRole('dialog', { name: ASK })).getByRole('button', { name: 'Choose client zone' }));
    await screen.findByRole('dialog', { name: 'Client zone' });
    await act(async () => {
      loseLease(s);
      await emit('state-changed');
    });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    // The other computer is in use, so there is no take over yet. When it goes quiet there is.
    expect(within(await screen.findByTestId('lease-banner')).queryByRole('button', { name: 'Take over…' })).toBeNull();
    await goesQuiet(s);
    await takeOver(u);
    expect(await screen.findByRole('dialog', { name: ASK })).toBeVisible();
    expect(screen.queryByRole('dialog', { name: 'Client zone' })).toBeNull();
  });
});
