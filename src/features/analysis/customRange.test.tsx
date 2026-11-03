// UI review R4: typing a year into a custom From or To date must not destroy the range. A date input reports
// each partial year as it is typed (0002, 0020, 0202, 2026), the day arithmetic read the years 0 to 99 as
// 1900 to 1999, and the range was swapped and clamped on every change, so the other end was rewritten.
import { clearMocks } from '@tauri-apps/api/mocks';
import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { boot, polyfillDom } from '../../components/testKit';
import { addDays } from '../../lib/tz';
import { demoState } from '../../mocks/demoSeed';
import { PeriodPicker } from '../billing/parts';
import { isRangeDay, spanDays, withCustomEnd, type RangeSpec } from './range';

beforeEach(polyfillDom);
afterEach(() => clearMocks());

/** The values a date input reports while 2026 is typed into its year, month and day staying as they are. */
const typedYear = (day: string, year = '2026'): string[] => [...Array.from({ length: year.length - 1 }, (_, i) => `${year.slice(0, i + 1).padStart(4, '0')}${day.slice(4)}`), `${year}${day.slice(4)}`];

describe('R4: the range arithmetic', () => {
  it('the day arithmetic reads the years 0 to 99 as they are', () => {
    expect(addDays('0002-03-01', 31)).toBe('0002-04-01');
    expect(addDays('0099-12-31', 1)).toBe('0100-01-01');
  });

  it('a From typed digit by digit leaves the range where it was', () => {
    let span = { fromDay: '2026-03-01', toDay: '2026-03-31' };
    for (const typed of typedYear('2026-03-01')) span = spanDays({ kind: 'custom', anchor: typed, from: typed, to: span.toDay });
    expect(span).toEqual({ fromDay: '2026-03-01', toDay: '2026-03-31' });
  });

  it('a To typed digit by digit leaves the range where it was', () => {
    let span = { fromDay: '2026-03-01', toDay: '2026-03-31' };
    for (const typed of typedYear('2026-03-31')) span = spanDays({ kind: 'custom', anchor: span.fromDay, from: span.fromDay, to: typed });
    expect(span).toEqual({ fromDay: '2026-03-01', toDay: '2026-03-31' });
  });
});

describe('R4: which days a range is made of', () => {
  it('takes a real day from 1970 on, with four digits for the year', () => {
    expect(['1970-01-01', '2026-03-31', '2024-02-29', '9999-12-31'].map(isRangeDay)).toEqual([true, true, true, true]);
    expect(['', '0002-03-01', '0202-03-01', '1969-12-31', '2026-02-30', '2026-13-01', '12026-03-01', '2026-3-1', 'x'].map(isRangeDay)).toEqual(Array(9).fill(false));
    expect(isRangeDay(undefined)).toBe(false);
  });

  it('setting one end keeps the other as it was set, not as the range reads once cut to the longest span', () => {
    const wide: RangeSpec = { kind: 'custom', anchor: '2019-03-01', from: '2019-03-01', to: '2026-03-31' };
    // 2019-03-01 to 2026-03-31 is longer than the longest span, so the range reads shorter than it was set.
    expect(spanDays(wide).toDay).not.toBe('2026-03-31');
    expect(withCustomEnd(wide, 'from', '2025-03-01')).toEqual({ kind: 'custom', anchor: '2025-03-01', from: '2025-03-01', to: '2026-03-31' });
    expect(withCustomEnd(wide, 'to', '2020-03-31')).toEqual({ kind: 'custom', anchor: '2019-03-01', from: '2019-03-01', to: '2020-03-31' });
  });
});

describe('R4: the Billing period picker', () => {
  function Picker() {
    const [range, setRange] = useState<RangeSpec>({ kind: 'custom', anchor: '2026-03-01', from: '2026-03-01', to: '2026-03-31' });
    return <PeriodPicker range={range} onChange={setRange} today="2026-03-12" />;
  }
  const field = (label: string) => screen.getByLabelText(label) as HTMLInputElement;

  it('keeps both ends while a year is typed into From', () => {
    render(<Picker />);
    for (const typed of typedYear('2026-03-01')) fireEvent.change(field('From'), { target: { value: typed } });
    expect([field('From').value, field('To').value]).toEqual(['2026-03-01', '2026-03-31']);
    expect(screen.getByText('1 Mar – 31 Mar 2026')).toBeTruthy();
  });

  it('keeps both ends while a year is typed into To', () => {
    render(<Picker />);
    for (const typed of typedYear('2026-03-31')) fireEvent.change(field('To'), { target: { value: typed } });
    expect([field('From').value, field('To').value]).toEqual(['2026-03-01', '2026-03-31']);
  });

  it('goes back to the day the range has when a half-typed year is left', () => {
    render(<Picker />);
    fireEvent.change(field('From'), { target: { value: '0202-03-01' } });
    expect(field('From').value).toBe('0202-03-01');
    fireEvent.blur(field('From'));
    expect([field('From').value, field('To').value]).toEqual(['2026-03-01', '2026-03-31']);
  });

  it('takes a complete date typed over another year', () => {
    render(<Picker />);
    for (const typed of typedYear('2026-03-01', '2025')) fireEvent.change(field('From'), { target: { value: typed } });
    expect([field('From').value, field('To').value]).toEqual(['2025-03-01', '2026-03-31']);
  });
});

describe('R4: the Analysis custom range', () => {
  it('keeps both ends while a year is typed into From', async () => {
    const user = userEvent.setup();
    boot(demoState());
    await user.click(await screen.findByRole('tab', { name: 'Analysis' }));
    await user.click(await screen.findByRole('radio', { name: 'Custom' }));
    const from = screen.getByLabelText('From') as HTMLInputElement;
    const to = screen.getByLabelText('To') as HTMLInputElement;
    const [fromDay, toDay] = [from.value, to.value];
    for (const typed of typedYear(fromDay)) {
      fireEvent.change(from, { target: { value: typed } });
      // The year is held in the field as typed, and the other end stays where it was.
      expect([from.value, to.value]).toEqual([typed, toDay]);
    }
    expect([from.value, to.value]).toEqual([fromDay, toDay]);
  });

  it('goes back to the day the range has when a half-typed year is left', async () => {
    const user = userEvent.setup();
    boot(demoState());
    await user.click(await screen.findByRole('tab', { name: 'Analysis' }));
    await user.click(await screen.findByRole('radio', { name: 'Custom' }));
    const from = screen.getByLabelText('From') as HTMLInputElement;
    const [fromDay, toDay] = [from.value, (screen.getByLabelText('To') as HTMLInputElement).value];
    fireEvent.change(from, { target: { value: `0202${fromDay.slice(4)}` } });
    fireEvent.blur(from);
    expect([from.value, (screen.getByLabelText('To') as HTMLInputElement).value]).toEqual([fromDay, toDay]);
  });
});

describe('R4 (review): the fields show the range the app uses', () => {
  const custom = (from: string, to: string): RangeSpec => ({ kind: 'custom', anchor: from, from, to });
  /** The picker, and the range it was last asked to take. */
  function Recorded({ initial, last }: { initial: RangeSpec; last: { current: RangeSpec } }) {
    const [range, setRange] = useState(initial);
    return (
      <PeriodPicker
        range={range}
        onChange={(r) => {
          last.current = r;
          setRange(r);
        }}
        today="2026-03-12"
      />
    );
  }
  function setup(initial: RangeSpec) {
    const last = { current: initial };
    render(<Recorded initial={initial} last={last} />);
    const shown = (): string[] => [(screen.getByLabelText('From') as HTMLInputElement).value, (screen.getByLabelText('To') as HTMLInputElement).value];
    const used = (): string[] => [spanDays(last.current).fromDay, spanDays(last.current).toDay];
    const type = (label: 'From' | 'To', value: string): void => void fireEvent.change(screen.getByLabelText(label), { target: { value } });
    return { shown, used, type };
  }

  it('a day typed that leaves the end as it was does not stay in the field', () => {
    const { shown, used, type } = setup(custom('2026-03-10', '2026-03-31'));
    type('To', '2026-03-01');
    expect(shown()).toEqual(used());
    type('To', '2026-03-02');
    expect(shown()).toEqual(used());
  });

  it('the same from the other end', () => {
    const { shown, used, type } = setup(custom('2026-03-01', '2026-03-10'));
    type('From', '2026-03-20');
    expect(shown()).toEqual(used());
    type('From', '2026-03-25');
    expect(shown()).toEqual(used());
  });

  it('a day past the longest span shows the end it was cut to', () => {
    const { shown, used, type } = setup(custom('2020-01-01', '2026-03-31'));
    expect(shown()[1]).toBe('2025-01-03');
    type('To', '2025-06-01');
    expect(shown()).toEqual(used());
    expect(shown()).toEqual(['2020-01-01', '2025-01-03']);
  });

  it('widening a range that was swapped starts from the days on screen', () => {
    const { shown, type } = setup(custom('2026-03-01', '2026-03-31'));
    type('From', '2026-04-15');
    expect(shown()).toEqual(['2026-03-31', '2026-04-15']);
    type('From', '2026-03-01');
    expect(shown()).toEqual(['2026-03-01', '2026-04-15']);
  });

  it('an end set past the other swaps them, so the range is what the screen shows', () => {
    const swapped = withCustomEnd(custom('2026-03-01', '2026-03-31'), 'from', '2026-04-15');
    expect(swapped).toEqual(custom('2026-03-31', '2026-04-15'));
    expect(withCustomEnd(swapped, 'from', '2026-03-01')).toEqual(custom('2026-03-01', '2026-04-15'));
  });
});
