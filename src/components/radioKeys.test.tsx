// Arrow keys on every radio group the app draws as buttons, and Home and End in the colour picker.
import { clearMocks } from '@tauri-apps/api/mocks';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { demoState } from '../mocks/demoSeed';
import { boot, polyfillDom } from './testKit';

beforeEach(() => {
  polyfillDom();
  window.localStorage.clear();
});
afterEach(() => clearMocks());

describe('theme choice', () => {
  it('has one tab stop, arrows choose, Home and End jump', async () => {
    const s = demoState();
    const user = userEvent.setup();
    boot(s);
    await user.click(await screen.findByRole('tab', { name: 'Settings' }));
    const group = await screen.findByRole('radiogroup', { name: 'Theme' });
    const radios = within(group).getAllByRole('radio');
    expect(radios.filter((r) => r.getAttribute('tabindex') === '0')).toHaveLength(1);
    within(group).getByRole('radio', { name: 'Light' }).focus();
    await user.keyboard('{ArrowRight}');
    await waitFor(() => expect(s.theme).toBe('solarizedLight'));
    expect(within(group).getByRole('radio', { name: 'Solarized Light' })).toHaveFocus();
    await user.keyboard('{End}');
    await waitFor(() => expect(s.theme).toBe('dark'));
    await user.keyboard('{ArrowRight}');
    await waitFor(() => expect(s.theme).toBe('light'));
    await user.keyboard('{ArrowLeft}');
    await waitFor(() => expect(s.theme).toBe('dark'));
    await user.keyboard('{Home}');
    await waitFor(() => expect(s.theme).toBe('light'));
  });
});

describe('analysis controls', () => {
  it('Range and Time basis answer arrow keys and keep one tab stop each', async () => {
    const user = userEvent.setup();
    boot(demoState());
    await user.click(await screen.findByRole('tab', { name: 'Analysis' }));
    const range = await screen.findByRole('radiogroup', { name: 'Range' });
    const checked = within(range).getAllByRole('radio').find((r) => r.getAttribute('aria-checked') === 'true');
    expect(checked).toBeDefined();
    expect(within(range).getAllByRole('radio').filter((r) => r.getAttribute('tabindex') === '0')).toHaveLength(1);
    checked?.focus();
    await user.keyboard('{ArrowRight}');
    await waitFor(() => expect(within(range).getAllByRole('radio').filter((r) => r.getAttribute('aria-checked') === 'true')[0]).not.toBe(checked));
    const before = within(range).getAllByRole('radio').findIndex((r) => r.getAttribute('aria-checked') === 'true');
    await user.keyboard('{Home}');
    await waitFor(() => expect(within(range).getAllByRole('radio')[0]).toHaveAttribute('aria-checked', 'true'));
    expect(before).toBeGreaterThan(0);
    const basis = screen.getByRole('radiogroup', { name: 'Time basis' });
    within(basis).getByRole('radio', { name: 'Exact' }).focus();
    await user.keyboard('{ArrowLeft}');
    await waitFor(() => expect(within(basis).getByRole('radio', { name: 'Billable' })).toHaveAttribute('aria-checked', 'true'));
  });
});

describe('colour picker swatches', () => {
  it('arrows wrap, Home and End jump, and the tab stop is the chosen colour', async () => {
    const user = userEvent.setup();
    boot(demoState());
    await user.click(await screen.findByRole('tab', { name: 'Projects' }));
    await user.click(screen.getByRole('button', { name: 'New project' }));
    const form = screen.getByRole('form', { name: 'New project' });
    const group = within(form).getByRole('radiogroup', { name: /colour/i });
    const swatches = within(group).getAllByRole('radio');
    expect(swatches.filter((r) => r.getAttribute('tabindex') === '0')).toHaveLength(1);
    swatches[1]?.focus();
    await user.keyboard('{End}');
    expect(swatches.at(-1)).toHaveFocus();
    expect(swatches.at(-1)).toHaveAttribute('aria-checked', 'true');
    await user.keyboard('{ArrowRight}');
    expect(swatches[0]).toHaveFocus();
    await user.keyboard('{ArrowLeft}');
    expect(swatches.at(-1)).toHaveFocus();
    await user.keyboard('{Home}');
    expect(swatches[0]).toHaveFocus();
    expect(swatches[0]).toHaveAttribute('aria-checked', 'true');
  });
});
