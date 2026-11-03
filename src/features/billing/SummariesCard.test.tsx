// Voiding a summary asks first. Once it is asked, the dialog stays until the backend has answered.
import { clearMocks } from '@tauri-apps/api/mocks';
import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { boot, polyfillDom } from '../../components/testKit';
import { api } from '../../lib/api';
import { demoP2State } from '../../mocks/demoSeed';

beforeEach(polyfillDom);
afterEach(() => {
  clearMocks();
  vi.restoreAllMocks();
});

describe('Void summary while the void is running', () => {
  /** A void that stays unanswered until the test refuses it, and the dialog asking about A-001. */
  async function voidRunning() {
    const user = userEvent.setup();
    const s = demoP2State();
    boot(s);
    await user.click(await screen.findByRole('tab', { name: 'Billing' }));
    let refuse: (e: Error) => void = () => undefined;
    const answer = new Promise<never>((_, reject) => {
      refuse = reject;
    });
    vi.spyOn(api, 'voidSummary').mockImplementation(() => answer);
    await user.click(await screen.findByRole('button', { name: 'Void A-001' }));
    const dialog = within(await screen.findByRole('dialog', { name: 'Void A-001?' }));
    await user.click(dialog.getByRole('button', { name: 'Void summary' }));
    await dialog.findByRole('button', { name: 'Voiding…' });
    const fail = async (message: string): Promise<void> => {
      await act(async () => {
        refuse(new Error(message));
        await answer.catch(() => undefined);
      });
    };
    return { user, s, dialog, fail };
  }

  it('R15: Cancel and Esc leave the dialog open until the answer, so a refusal is seen', async () => {
    const { user, s, dialog, fail } = await voidRunning();
    // Cancel is pressed, and so is Esc, while the void is still out.
    await user.click(dialog.getByRole('button', { name: 'Cancel' }));
    await user.keyboard('{Escape}');
    expect(screen.getByRole('dialog', { name: 'Void A-001?' })).toBeVisible();
    await fail('the history could not be written');
    expect(await dialog.findByRole('alert')).toHaveTextContent('the history could not be written');
    expect(s.summaries.find((b) => b.reference === 'A-001')?.voided).toBe(false);
  });

  it('R15: after a refusal Cancel works again and closes the dialog', async () => {
    const { user, dialog, fail } = await voidRunning();
    await fail('the history could not be written');
    await dialog.findByRole('alert');
    await user.click(dialog.getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Void A-001?' })).toBeNull());
  });

  it('R15: Cancel is disabled and the dialog has no close button while the void runs, and neither once it has answered', async () => {
    const { dialog, fail } = await voidRunning();
    expect(dialog.getByRole('button', { name: 'Cancel' })).toBeDisabled();
    expect(dialog.queryByRole('button', { name: 'Close dialog' })).toBeNull();
    await fail('no');
    await dialog.findByRole('alert');
    expect(dialog.getByRole('button', { name: 'Cancel' })).toBeEnabled();
    expect(dialog.getByRole('button', { name: 'Close dialog' })).toBeEnabled();
  });
});
