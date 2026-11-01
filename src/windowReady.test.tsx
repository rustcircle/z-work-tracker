// The Windows window is transparent and hidden until the page says it has painted: once, after first paint,
// and a failure must change nothing because the backend shows the window by itself after a few seconds.
import { clearMocks } from '@tauri-apps/api/mocks';
import { screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { boot, polyfillDom } from './components/testKit';
import { api } from './lib/api';
import { emptyState } from './mocks/ipcMock';

beforeEach(polyfillDom);
afterEach(() => {
  clearMocks();
  vi.restoreAllMocks();
});

describe('window_ready', () => {
  it('is sent once after the first paint', async () => {
    const s = emptyState();
    boot(s);
    await screen.findByRole('tab', { name: 'Timeline' });
    await waitFor(() => expect(s.calls.filter((c) => c.cmd === 'window_ready')).toHaveLength(1));
    await new Promise((r) => setTimeout(r, 100));
    expect(s.calls.filter((c) => c.cmd === 'window_ready')).toHaveLength(1);
  });

  it('is sent before the data has even loaded, and a failure is ignored', async () => {
    const spy = vi.spyOn(api, 'windowReady').mockRejectedValue(new Error('no such command'));
    boot(emptyState());
    await waitFor(() => expect(spy).toHaveBeenCalledTimes(1));
    expect(await screen.findByRole('tab', { name: 'Timeline' })).toBeVisible();
  });
});
