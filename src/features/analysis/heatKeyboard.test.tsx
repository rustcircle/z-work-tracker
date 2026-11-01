import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { CalendarHeat, WeekdayHourHeat, type CalDay } from './charts';

const ROWS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const cells = Array.from({ length: 7 * 24 }, (_, i) => (i === 2 * 24 + 10 ? 3600 : 0));

function hours(onSelect?: (row: number, hour: number) => void) {
  return render(
    <WeekdayHourHeat cells={cells} max={3600} rowLabels={ROWS} tipFor={(r, h) => [`${ROWS[r]} ${String(h).padStart(2, '0')}:00`, r === 2 && h === 10 ? '1h' : '0m']} ariaLabel="Heatmap of logged time" {...(onSelect ? { onSelect } : {})} />,
  );
}

const DAYS: CalDay[] = Array.from({ length: 21 }, (_, i) => ({ day: `2026-03-${String(i + 1).padStart(2, '0')}`, dayNum: 20523 + i, secs: i === 4 ? 7200 : 0 }));
function calendar(onSelect?: (d: CalDay) => void) {
  return render(<CalendarHeat days={DAYS} max={7200} weekdayOf={(n) => (n + 3) % 7} tipFor={(d) => [d.day, d.secs ? '2h' : '0m']} ariaLabel="Calendar heatmap of days" {...(onSelect ? { onSelect } : {})} />);
}

describe('weekday by hour heatmap', () => {
  it('without a drill-down it is a plain image with no tab stops', () => {
    hours();
    expect(screen.getByRole('img', { name: 'Heatmap of logged time' })).toBeVisible();
    expect(screen.queryAllByRole('button')).toEqual([]);
  });

  it('is one tab stop, starting on the first cell with time, and every cell says what it holds', async () => {
    hours(vi.fn());
    const buttons = screen.getAllByRole('button');
    expect(buttons).toHaveLength(7 * 24);
    expect(buttons.filter((b) => b.getAttribute('tabindex') === '0')).toHaveLength(1);
    expect(screen.getByRole('button', { name: 'Wed 10:00, 1h' })).toHaveAttribute('tabindex', '0');
  });

  it('arrows move between cells, Home and End jump, Enter drills down, and the tab stop follows', async () => {
    const onSelect = vi.fn();
    const user = userEvent.setup();
    hours(onSelect);
    screen.getByRole('button', { name: 'Wed 10:00, 1h' }).focus();
    await user.keyboard('{ArrowRight}');
    expect(screen.getByRole('button', { name: 'Wed 11:00, 0m' })).toHaveFocus();
    await user.keyboard('{ArrowDown}');
    expect(screen.getByRole('button', { name: 'Thu 11:00, 0m' })).toHaveFocus();
    await user.keyboard('{Home}');
    expect(screen.getByRole('button', { name: 'Thu 00:00, 0m' })).toHaveFocus();
    await user.keyboard('{End}');
    expect(screen.getByRole('button', { name: 'Thu 23:00, 0m' })).toHaveFocus();
    await user.keyboard('{ArrowRight}');
    expect(screen.getByRole('button', { name: 'Thu 23:00, 0m' })).toHaveFocus();
    await user.keyboard('{Enter}');
    expect(onSelect).toHaveBeenLastCalledWith(3, 23);
    await user.keyboard(' ');
    expect(onSelect).toHaveBeenCalledTimes(2);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Thu 23:00, 0m' })).toHaveAttribute('tabindex', '0'));
    expect(screen.getAllByRole('button').filter((b) => b.getAttribute('tabindex') === '0')).toHaveLength(1);
  });

  it('shows the tooltip text on focus, like hovering', async () => {
    const user = userEvent.setup();
    hours(vi.fn());
    await user.tab();
    expect(await screen.findByRole('tooltip')).toHaveTextContent('Wed 10:00');
  });
});

describe('calendar heatmap', () => {
  it('Up and Down are a day, Left and Right a week, Enter drills down', async () => {
    const onSelect = vi.fn();
    const user = userEvent.setup();
    calendar(onSelect);
    expect(screen.getAllByRole('button')).toHaveLength(DAYS.length);
    const start = screen.getByRole('button', { name: '2026-03-05, 2h' });
    expect(start).toHaveAttribute('tabindex', '0');
    start.focus();
    await user.keyboard('{ArrowDown}');
    expect(screen.getByRole('button', { name: '2026-03-06, 0m' })).toHaveFocus();
    await user.keyboard('{ArrowRight}');
    expect(screen.getByRole('button', { name: '2026-03-13, 0m' })).toHaveFocus();
    await user.keyboard('{ArrowLeft}{ArrowLeft}');
    expect(screen.getByRole('button', { name: '2026-03-06, 0m' })).toHaveFocus();
    await user.keyboard('{End}');
    expect(screen.getByRole('button', { name: '2026-03-21, 0m' })).toHaveFocus();
    await user.keyboard('{Home}');
    expect(screen.getByRole('button', { name: '2026-03-01, 0m' })).toHaveFocus();
    await user.keyboard('{ArrowUp}');
    expect(screen.getByRole('button', { name: '2026-03-01, 0m' })).toHaveFocus();
    await user.keyboard('{Enter}');
    expect(onSelect).toHaveBeenLastCalledWith(expect.objectContaining({ day: '2026-03-01' }));
  });
});
