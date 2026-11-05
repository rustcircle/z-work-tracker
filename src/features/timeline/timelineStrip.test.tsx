// The Timeline's days side by side, through the real app on the IPC mock: the oldest on the left and today on the
// right, the arrows that page back and forward, and how many days fit the width.
import { clearMocks } from '@tauri-apps/api/mocks';
import { act, cleanup, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { boot, polyfillDom } from '../../components/testKit';
import { demoState } from '../../mocks/demoSeed';

// jsdom has no layout, so the strip's width and its ResizeObserver are stood in for. 1452 px is the Timeline of a
// 1920 px window, where three days fit.
let width = 1452;
const watchers = new Set<() => void>();
class FakeResizeObserver {
  constructor(private readonly onResize: () => void) {
    watchers.add(this.onResize);
  }
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {
    watchers.delete(this.onResize);
  }
}
const resize = (to: number) =>
  act(() => {
    width = to;
    for (const w of watchers) w();
  });

beforeEach(() => {
  polyfillDom();
  width = 1452;
  watchers.clear();
  vi.stubGlobal('ResizeObserver', FakeResizeObserver);
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', {
    configurable: true,
    get(this: HTMLElement) {
      return this.classList.contains('days') ? width : 0;
    },
  });
});
afterEach(() => {
  cleanup();
  clearMocks();
  vi.unstubAllGlobals();
  Reflect.deleteProperty(HTMLElement.prototype, 'clientWidth');
});

/** The days drawn, left to right. */
const shownDays = (): string[] => [...document.querySelectorAll('article[data-day]')].map((a) => a.getAttribute('data-day') ?? '');
const earlier = (): HTMLButtonElement => screen.getByRole('button', { name: 'Earlier days' });
const later = (): HTMLButtonElement => screen.getByRole('button', { name: 'Later days' });
const range = (): string => screen.getByTestId('day-range').textContent ?? '';
const bar = () => screen.queryByTestId('selection-bar');
const rowsOf = (day: string): HTMLElement[] => within(screen.getByRole('article', { name: day })).getAllByTestId('entry');

async function open() {
  const user = userEvent.setup();
  boot(demoState());
  await screen.findByRole('region', { name: 'Timeline' });
  await screen.findAllByTestId('entry');
  return user;
}

// The demo has 14 days with time: Feb 23 to 27, Mar 2 to 6, and Mar 9 to 12 (today).
describe('the days, side by side', () => {
  it('open on the newest days: the oldest on the left, today on the right', async () => {
    await open();
    expect(shownDays()).toEqual(['2026-03-10', '2026-03-11', '2026-03-12']);
    expect(range()).toBe('Tue 10 Mar 2026 to Thu 12 Mar 2026');
    // The old pager is gone: older days come with the arrows.
    expect(screen.queryByRole('button', { name: /Show older/ })).toBeNull();
  });

  it('keep each day whole: its header with the Billable total, its axis and its bands', async () => {
    await open();
    for (const day of ['Tue 10 Mar 2026', 'Wed 11 Mar 2026', 'Thu 12 Mar 2026']) {
      const card = within(screen.getByRole('article', { name: day }));
      expect(card.getByTestId('day-billable')).toBeInTheDocument();
      expect(card.getByRole('group', { name: /axis$/ })).toBeInTheDocument();
      expect(card.getAllByRole('rowgroup').length).toBeGreaterThan(0);
    }
    const today = within(screen.getByRole('article', { name: 'Thu 12 Mar 2026' }));
    expect(today.getByRole('rowgroup', { name: /^Morning 06–12$/ })).toBeInTheDocument();
    expect(today.getByRole('rowgroup', { name: /^Afternoon 12–18$/ })).toBeInTheDocument();
  });
});

describe('the arrows', () => {
  it('are buttons with names, and Later days is off while today is the rightmost day', async () => {
    await open();
    expect(earlier().tagName).toBe('BUTTON');
    expect(later().tagName).toBe('BUTTON');
    expect(later()).toBeDisabled();
    expect(earlier()).toBeEnabled();
  });

  it('Earlier days pages back, Later days pages forward again, and the oldest day is always on the left', async () => {
    const user = await open();
    await user.click(earlier());
    expect(shownDays()).toEqual(['2026-03-05', '2026-03-06', '2026-03-09']);
    expect(range()).toBe('Thu 5 Mar 2026 to Mon 9 Mar 2026');
    expect(later()).toBeEnabled();
    await user.click(earlier());
    expect(shownDays()).toEqual(['2026-03-02', '2026-03-03', '2026-03-04']);
    await user.click(later());
    expect(shownDays()).toEqual(['2026-03-05', '2026-03-06', '2026-03-09']);
    await user.click(later());
    expect(shownDays()).toEqual(['2026-03-10', '2026-03-11', '2026-03-12']);
    expect(later()).toBeDisabled();
    expect(earlier()).toBeEnabled();
  });

  it('stop Earlier days at the oldest day, with the strip still full', async () => {
    const user = await open();
    for (let i = 0; i < 10 && !earlier().disabled; i += 1) await user.click(earlier());
    expect(earlier()).toBeDisabled();
    expect(shownDays()).toEqual(['2026-02-23', '2026-02-24', '2026-02-25']);
    expect(later()).toBeEnabled();
  });

  it('work from the keyboard: reached by focus, Enter and Space, and focus stays on the button', async () => {
    const user = await open();
    act(() => earlier().focus());
    await user.keyboard('{Enter}');
    expect(shownDays()).toEqual(['2026-03-05', '2026-03-06', '2026-03-09']);
    expect(earlier()).toHaveFocus();
    act(() => later().focus());
    await user.keyboard(' ');
    expect(shownDays()).toEqual(['2026-03-10', '2026-03-11', '2026-03-12']);
    expect(later()).toBeDisabled();
  });

  it('hand the focus to the other arrow when one turns itself off at the end of the days, so the keyboard is never dropped on the page', async () => {
    const user = await open();
    // Forward to today: Later days turns off with the focus on it.
    act(() => earlier().focus());
    await user.keyboard('{Enter}');
    act(() => later().focus());
    await user.keyboard('{Enter}');
    expect(later()).toBeDisabled();
    expect(earlier()).toHaveFocus();
    // Back to the oldest day: Earlier days turns off with the focus on it.
    for (let i = 0; i < 10 && !earlier().disabled; i += 1) await user.keyboard('{Enter}');
    expect(earlier()).toBeDisabled();
    expect(later()).toHaveFocus();
  });

  it('keep a selection while paging, and the selection bar says it is on a day not shown', async () => {
    const user = await open();
    const row = rowsOf('Thu 12 Mar 2026')[0] as HTMLElement;
    await user.click(row);
    expect(within(bar() as HTMLElement).getByTestId('selection-count')).toHaveTextContent('1 task selected');
    expect(bar()).not.toHaveTextContent(/not on screen/);
    await user.click(earlier());
    expect(within(bar() as HTMLElement).getByTestId('selection-count')).toHaveTextContent('1 task selected');
    expect(bar()).toHaveTextContent(/1 of them is not on screen now/);
    await user.click(later());
    expect(screen.getByRole('article', { name: 'Thu 12 Mar 2026' })).toBeInTheDocument();
    expect(rowsOf('Thu 12 Mar 2026')[0]).toHaveAttribute('aria-selected', 'true');
    expect(bar()).not.toHaveTextContent(/not on screen/);
  });

  it('keep what was chosen when Ctrl+Shift+click is on another page than the anchor, adding the row clicked', async () => {
    const user = await open();
    const ctrl = async (row: HTMLElement) => {
      await user.keyboard('{Control>}');
      await user.click(row);
      await user.keyboard('{/Control}');
    };
    await user.click(rowsOf('Tue 10 Mar 2026')[0] as HTMLElement);
    await ctrl(rowsOf('Wed 11 Mar 2026')[0] as HTMLElement);
    await ctrl(rowsOf('Thu 12 Mar 2026')[0] as HTMLElement);
    expect(screen.getByTestId('selection-count')).toHaveTextContent('3 tasks selected');
    // The anchor, today's row, is not on screen once the strip pages back.
    await user.click(earlier());
    await user.keyboard('{Control>}{Shift>}');
    await user.click(rowsOf('Mon 9 Mar 2026')[0] as HTMLElement);
    await user.keyboard('{/Shift}{/Control}');
    expect(screen.getByTestId('selection-count')).toHaveTextContent('4 tasks selected');
    expect(bar()).toHaveTextContent(/3 of them are not on screen now/);
  });

  it('give Ctrl+A only the days shown', async () => {
    const user = await open();
    await user.click(earlier());
    act(() => (rowsOf('Mon 9 Mar 2026')[0] as HTMLElement).focus());
    await user.keyboard('{Control>}a{/Control}');
    // Every task-day on screen is in, and none of the 11 other days is.
    const onScreen = new Set(screen.getAllByTestId('entry').map((r) => r.getAttribute('data-sel-key')).filter((k): k is string => k !== null));
    expect(onScreen.size).toBeGreaterThan(1);
    expect(screen.getByTestId('selection-count')).toHaveTextContent(`${onScreen.size} tasks selected`);
    expect(bar()).not.toHaveTextContent(/not on screen/);
  });
});

describe('how many days fit', () => {
  it('shows as many as the width holds, at least one, and follows the window', async () => {
    width = 892; // a 1360 px window
    await open();
    expect(shownDays()).toEqual(['2026-03-11', '2026-03-12']);
    await resize(1452); // 1920 px
    expect(shownDays()).toEqual(['2026-03-10', '2026-03-11', '2026-03-12']);
    await resize(532); // 1000 px
    expect(shownDays()).toEqual(['2026-03-12']);
    await resize(120); // far too narrow: still one
    expect(shownDays()).toEqual(['2026-03-12']);
  });

  it('keeps what it showed while the window has no width, as when it is hidden', async () => {
    width = 892;
    await open();
    await resize(0);
    expect(shownDays()).toEqual(['2026-03-11', '2026-03-12']);
    await resize(1452);
    expect(shownDays()).toEqual(['2026-03-10', '2026-03-11', '2026-03-12']);
  });

  it('follows the newest day again once a wider window has brought the strip to it, so narrowing returns to the newest days', async () => {
    const user = await open();
    for (let i = 0; i < 10 && !earlier().disabled; i += 1) await user.click(earlier());
    expect(shownDays()).toEqual(['2026-02-23', '2026-02-24', '2026-02-25']);
    // All 14 days fit: the strip reaches the newest end, Later days is off, and nothing is held any more.
    await resize(6200);
    expect(shownDays()).toHaveLength(14);
    expect(later()).toBeDisabled();
    await resize(1452);
    expect(shownDays()).toEqual(['2026-03-10', '2026-03-11', '2026-03-12']);
    expect(later()).toBeDisabled();
  });

  it('draws a fortnight where there is no layout at all, as the Timeline always did', async () => {
    width = 0;
    await open();
    expect(shownDays()).toHaveLength(14);
    expect(shownDays().at(0)).toBe('2026-02-23');
    expect(shownDays().at(-1)).toBe('2026-03-12');
    expect(earlier()).toBeDisabled();
    expect(later()).toBeDisabled();
  });

  it('keeps the day at the right edge when the window changes after paging back', async () => {
    width = 892;
    const user = await open();
    await user.click(earlier());
    expect(shownDays()).toEqual(['2026-03-09', '2026-03-10']);
    await resize(1452);
    expect(shownDays()).toEqual(['2026-03-06', '2026-03-09', '2026-03-10']);
    await resize(532);
    expect(shownDays()).toEqual(['2026-03-10']);
    // Narrow, a step is one day: two steps forward reach today, and then Later days is off.
    await user.click(later());
    expect(shownDays()).toEqual(['2026-03-11']);
    expect(later()).toBeEnabled();
    await user.click(later());
    expect(shownDays()).toEqual(['2026-03-12']);
    expect(later()).toBeDisabled();
  });
});
