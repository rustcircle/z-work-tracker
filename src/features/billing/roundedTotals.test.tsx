// What the Billing tab says when a row bills only a difference, or when rows don't add up to their total.
import { clearMocks } from '@tauri-apps/api/mocks';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { boot, polyfillDom } from '../../components/testKit';
import { DEVICE_ID, emptyState, handle, type MockState } from '../../mocks/ipcMock';
import type { Snapshot, WithId } from '../../lib/types';

beforeEach(polyfillDom);
afterEach(clearMocks);

const NOTE = 'Row amounts are rounded; the total is worked out from the exact amounts.';

function world(rateCents: number) {
  const s = emptyState('2026-03-20T12:00:00Z');
  const { id: projectId } = handle(s, 'create_project', { input: { name: 'P', color: '#2563EB', billable: true, budgetHours: null, clientZone: null } }) as WithId;
  handle(s, 'set_rate', { input: { projectId, rateCents, currency: 'EUR', effectiveFrom: '2026-01-01T00:00:00Z', confirmRetroactive: true } });
  handle(s, 'set_rounding', { input: { projectId: null, effectiveFrom: '2000-01-01', incrementMinutes: 15, method: 'up', confirmRetroactive: true }, today: '2026-03-20' });
  const { id: taskId } = handle(s, 'create_task', { input: { name: 'T', projectId, description: null, tags: ['tag-admin'] } }) as WithId;
  const add = (id: string, start: string, end: string): void => {
    s.segments.push({ id, taskId, deviceId: DEVICE_ID, start, end, provisionalEnd: null });
  };
  const bill = (): void => {
    const zone = (handle(s, 'get_snapshot', {}) as Snapshot).systemZone;
    handle(s, 'create_summary', { request: { projectId, from: '2026-03-01', to: '2026-03-31', zone } });
  };
  return { s, add, bill };
}

async function unbilled(s: MockState) {
  const user = userEvent.setup();
  boot(s);
  await user.click(await screen.findByRole('tab', { name: 'Billing' }));
  const card = within(screen.getByRole('region', { name: 'Unbilled time' }));
  await waitFor(() => expect(card.getByRole('table')).toBeVisible());
  return card;
}

describe('a row that bills a difference', () => {
  it('r8: the preview says so, and bills 15 of the second 20 minutes', async () => {
    const { s, add, bill } = world(6000);
    add('a', '2026-03-02T09:00:00Z', '2026-03-02T09:20:00Z');
    bill();
    add('b', '2026-03-02T14:00:00Z', '2026-03-02T14:20:00Z');
    const card = await unbilled(s);
    expect(card.getByTestId('billing-partly-billed')).toHaveTextContent("Part of this day's time is already on a summary. A task's time on a day rounds once as a whole, so this row bills only the difference.");
    expect(card.getByTestId('billing-total-amount')).toHaveTextContent('€15.00');
  });

  it('r8: says nothing of it for a day not billed before', async () => {
    const { s, add } = world(6000);
    add('a', '2026-03-02T09:00:00Z', '2026-03-02T09:20:00Z');
    add('b', '2026-03-02T14:00:00Z', '2026-03-02T14:20:00Z');
    const card = await unbilled(s);
    expect(card.queryByTestId('billing-partly-billed')).toBeNull();
    expect(card.getByTestId('billing-total-amount')).toHaveTextContent('€45.00');
  });
});

describe('rows that do not add up to their total', () => {
  const three = (rateCents: number) => {
    const w = world(rateCents);
    w.add('a', '2026-03-02T09:00:00Z', '2026-03-02T09:15:00Z');
    w.add('b', '2026-03-03T09:00:00Z', '2026-03-03T09:15:00Z');
    w.add('c', '2026-03-04T09:00:00Z', '2026-03-04T09:15:00Z');
    return w.s;
  };

  it('r7: the table says why, and shows the total worked out once', async () => {
    const card = await unbilled(three(3333));
    expect(card.getByTestId('billing-rounded-rows')).toHaveTextContent(NOTE);
    expect(card.getByTestId('billing-total-amount')).toHaveTextContent('€25.00');
    expect(card.getAllByText('€8.33')).toHaveLength(3);
  });

  it('r7: says nothing where they add up', async () => {
    const card = await unbilled(three(6000));
    expect(card.queryByTestId('billing-rounded-rows')).toBeNull();
  });

  it('r7: says nothing while Hide earnings masks the amounts', async () => {
    const s = three(3333);
    s.hideEarnings = true;
    const card = await unbilled(s);
    expect(card.queryByTestId('billing-rounded-rows')).toBeNull();
  });
});
