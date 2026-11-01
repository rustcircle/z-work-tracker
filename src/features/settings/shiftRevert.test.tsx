import { clearMocks } from '@tauri-apps/api/mocks';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { boot, polyfillDom } from '../../components/testKit';
import { demoState } from '../../mocks/demoSeed';
import { DEVICE_ID, type MockState } from '../../mocks/ipcMock';

beforeEach(polyfillDom);
afterEach(() => clearMocks());

/** The demo's Morning shift with a second, later version. */
function twoVersions(): MockState {
  const s = demoState();
  const first = s.shifts.find((v) => v.shiftId === 'sh-morning');
  if (!first) throw new Error('demo has no Morning shift');
  s.shifts.push({ ...first, id: 'sv-late', effectiveFrom: '2026-03-01', start: '08:00', end: '12:00', stamp: { at: '2026-03-01T00:00:00Z', by: DEVICE_ID } });
  return s;
}

async function versions(s: MockState) {
  const user = userEvent.setup();
  boot(s);
  await user.click(await screen.findByRole('tab', { name: 'Settings' }));
  const summary = await screen.findByText('2 versions');
  await user.click(summary);
  return { user, list: within(summary.closest('details') as HTMLElement) };
}

describe('revert a shift version', () => {
  it('is offered on each version of a shift that has more than one, and not on a shift with one', async () => {
    const s = twoVersions();
    const { list } = await versions(s);
    expect(list.getAllByRole('button', { name: /Revert this version/ })).toHaveLength(2);
    expect(screen.getAllByText(/\d versions/)).toHaveLength(1);
  });

  it('asks first, says what applies afterwards, and Cancel sends nothing', async () => {
    const s = twoVersions();
    const { user, list } = await versions(s);
    await user.click(list.getByRole('button', { name: /Revert this version of Morning from 2026-03-01/ }));
    const dialog = screen.getByRole('dialog', { name: 'Revert this version?' });
    expect(dialog).toHaveTextContent('starts on 2026-03-01');
    expect(dialog).toHaveTextContent('the earlier version applies again');
    expect(dialog).toHaveTextContent('09:00');
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(s.calls.some((c) => c.cmd === 'revert_shift_version')).toBe(false);
  });

  it('reverts the chosen version only, through the backend, and the list collapses to one version', async () => {
    const s = twoVersions();
    const { user, list } = await versions(s);
    await user.click(list.getByRole('button', { name: /Revert this version of Morning from 2026-03-01/ }));
    await user.click(within(screen.getByRole('dialog', { name: 'Revert this version?' })).getByRole('button', { name: 'Revert version' }));
    await waitFor(() => expect(s.calls.filter((c) => c.cmd === 'revert_shift_version').map((c) => c.args)).toEqual([{ versionId: 'sv-late' }]));
    await waitFor(() => expect(screen.queryByText('2 versions')).toBeNull());
    expect(s.shifts.find((v) => v.id === 'sv-late')?.deleted).toBe(true);
    expect(s.shifts.find((v) => v.shiftId === 'sh-morning' && !v.deleted)?.start).toBe('09:00');
  });

  it('the oldest version can go too, and the dialog says days before the next version have no band', async () => {
    const s = twoVersions();
    const { user, list } = await versions(s);
    const oldest = list.getAllByRole('button', { name: /Revert this version/ })[0];
    if (!oldest) throw new Error('no revert button');
    await user.click(oldest);
    expect(screen.getByRole('dialog', { name: 'Revert this version?' })).toHaveTextContent('first version');
  });
});
