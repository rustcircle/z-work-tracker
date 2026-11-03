// UI review R2: a zone picked in a select that later stops being offered (the zone bar moved, a zone was
// changed in Settings) must not stay the zone in use. The select shows the first option when its value is not
// among them, so the file, the PDF or the billing summary would be cut in a zone the screen does not show.
// Each test holds what the select shows to the zone the request carries.
import { emit } from '@tauri-apps/api/event';
import { clearMocks } from '@tauri-apps/api/mocks';
import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { boot, polyfillDom } from '../../components/testKit';
import { demoP2State, demoState } from '../../mocks/demoSeed';
import type { MockState } from '../../mocks/ipcMock';

beforeEach(polyfillDom);
afterEach(() => {
  clearMocks();
  vi.restoreAllMocks();
});

type User = ReturnType<typeof userEvent.setup>;

/** A change made elsewhere in the app (Settings, the zone bar) while the dialog or card is closed or hidden. */
async function change(s: MockState, patch: MockState['settings']): Promise<void> {
  s.settings = { ...s.settings, ...patch };
  await act(async () => {
    await emit('state-changed');
  });
}

const openExport = async (user: User) => {
  await user.click(await screen.findByRole('button', { name: /^Export/ }));
  return screen.findByRole('dialog', { name: 'Export' });
};

describe('R2: Export dialog', () => {
  it('Excel and CSV: the zone chosen earlier gives way to the default once it is not offered', async () => {
    const user = userEvent.setup();
    const s = demoState();
    s.settings = { ...s.settings, myZone: 'Europe/Lisbon', clientZone: 'America/New_York' };
    s.clientZonePromptDone = true;
    boot(s);
    let dialog = await openExport(user);
    await user.selectOptions(within(dialog).getByRole('combobox', { name: 'Cut days in' }), 'America/New_York');
    await user.click(within(dialog).getByRole('button', { name: 'Close' }));
    await change(s, { clientZone: 'Asia/Tokyo' });
    dialog = await openExport(user);
    const select = within(dialog).getByRole('combobox', { name: 'Cut days in' }) as HTMLSelectElement;
    await user.click(within(dialog).getByRole('button', { name: /Export Excel/ }));
    await waitFor(() => expect(s.exports).toHaveLength(1));
    expect(s.exports[0]?.request.dayZone).toBe(select.value);
    expect(select.value).toBe('Europe/Lisbon');
  });

  it('PDF: the zone chosen earlier gives way to the default once it is not offered', async () => {
    const user = userEvent.setup();
    const s = demoState();
    s.settings = { ...s.settings, myZone: 'Europe/Lisbon', clientZone: 'America/New_York' };
    s.clientZonePromptDone = true;
    boot(s);
    let dialog = await openExport(user);
    await user.click(within(dialog).getByRole('radio', { name: 'PDF timesheet (.pdf)' }));
    await user.selectOptions(within(dialog).getByLabelText('Days are cut in'), 'Europe/Lisbon');
    await user.click(within(dialog).getByRole('button', { name: 'Close' }));
    // My zone and the zone bar both move on: Lisbon is no longer offered.
    await change(s, { myZone: 'Asia/Tokyo', activeZone: null });
    dialog = await openExport(user);
    const select = within(dialog).getByLabelText('Days are cut in') as HTMLSelectElement;
    await user.click(within(dialog).getByRole('button', { name: /Export PDF/ }));
    await waitFor(() => expect(s.pdfExports).toHaveLength(1));
    expect(s.pdfExports[0]?.zone).toBe(select.value);
    expect(select.value).not.toBe('Europe/Lisbon');
  });
});

describe('R2: Unbilled time card', () => {
  it('previews and bills in the zone it shows, also when the zone bar moves on', async () => {
    const user = userEvent.setup();
    const s = demoP2State();
    s.settings = { ...s.settings, activeZone: 'Asia/Tokyo' };
    boot(s);
    await user.click(await screen.findByRole('tab', { name: 'Billing' }));
    const card = within(screen.getByRole('region', { name: 'Unbilled time' }));
    await waitFor(() => expect(card.getByRole('table')).toBeVisible());
    await user.selectOptions(card.getByLabelText('Days are cut in'), 'Asia/Tokyo');
    // The zone bar goes back to My time: Tokyo is no longer offered.
    await change(s, { activeZone: null });
    const select = card.getByLabelText('Days are cut in') as HTMLSelectElement;
    const zoneOfPreview = (): unknown => (s.calls.filter((c) => c.cmd === 'summary_preview').at(-1)?.args as { request?: { zone?: string } } | undefined)?.request?.zone;
    await waitFor(() => expect(zoneOfPreview()).toBe(select.value));
    expect(select.value).not.toBe('Asia/Tokyo');
  });
});
