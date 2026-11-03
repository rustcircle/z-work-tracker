// The hint under the client working hours says what the figures do with them (README, "Client working hours").
import { clearMocks } from '@tauri-apps/api/mocks';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, it } from 'vitest';

import { boot, polyfillDom } from '../../components/testKit';
import { demoState } from '../../mocks/demoSeed';

beforeEach(polyfillDom);
afterEach(() => clearMocks());

it('R6 follow-up: the working hours hint says that every day counts and that the hours may run overnight', async () => {
  const user = userEvent.setup();
  boot(demoState());
  await user.click(await screen.findByRole('tab', { name: 'Settings' }));
  const zones = within(await screen.findByRole('region', { name: 'Time zones' }));
  const hint = zones.getByText(/The client's day, in their zone/);
  expect(hint).toHaveTextContent('every day');
  expect(hint).toHaveTextContent('overnight');
  expect(hint).not.toHaveTextContent(/Monday to Friday|weekdays only/i);
});
