import { clearMocks } from '@tauri-apps/api/mocks';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { boot, polyfillDom } from '../../components/testKit';
import { emptyState, type MockState } from '../../mocks/ipcMock';

beforeEach(polyfillDom);
afterEach(() => {
  clearMocks();
  delete document.documentElement.dataset.mica;
});

async function setting(s: MockState) {
  boot(s);
  const user = userEvent.setup();
  await user.click(await screen.findByRole('tab', { name: 'Settings' }));
  return { user, box: within(await screen.findByTestId('mica-setting')) };
}

describe('Mica setting', () => {
  it('is off and disabled where the system cannot show it, and says why', async () => {
    const { box } = await setting(emptyState());
    const toggle = box.getByRole('switch', { name: 'Windows 11 Mica backdrop' });
    expect(toggle).toBeDisabled();
    expect(toggle).not.toBeChecked();
    expect(box.getByText(/needs Windows 11/)).toBeVisible();
    expect(document.documentElement.dataset.mica).toBeUndefined();
  });

  it('turns on, sets the backend, and marks the page; off again restores an opaque page', async () => {
    const s = emptyState();
    s.micaAvailable = true;
    const { user, box } = await setting(s);
    const toggle = box.getByRole('switch', { name: 'Windows 11 Mica backdrop' });
    expect(toggle).toBeEnabled();
    await user.click(toggle);
    await waitFor(() => expect(s.mica).toBe(true));
    await waitFor(() => expect(document.documentElement.dataset.mica).toBe('on'));
    expect(document.documentElement.style.getPropertyValue('--bg')).toMatch(/^rgb\(.* \/ 0\.9\)$/);
    await user.click(box.getByRole('switch', { name: 'Windows 11 Mica backdrop' }));
    await waitFor(() => expect(document.documentElement.dataset.mica).toBeUndefined());
    expect(document.documentElement.style.getPropertyValue('--bg')).toBe('#f3f4f6');
  });

  it('stays opaque under a Solarized theme even when on, and the hint says so', async () => {
    const s = emptyState();
    s.micaAvailable = true;
    s.mica = true;
    s.theme = 'solarizedDark';
    const { box } = await setting(s);
    await waitFor(() => expect(document.documentElement.dataset.theme).toBe('solarizedDark'));
    expect(document.documentElement.dataset.mica).toBeUndefined();
    expect(box.getByText(/Solarized keeps its exact colours/)).toBeVisible();
  });
});
