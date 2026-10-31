import { afterEach, describe, expect, it, vi } from 'vitest';

import { contrast, luminance, readableText, suggestColor, PROJECT_PALETTE } from './color';
import { BANDS, BandClock, splitAll, type Seg } from './split';
import { attributeSpan, versionOn, windowsFor } from './shifts';
import { THEMES } from './themes';
import type { ShiftVersion, Theme } from './types';
import { dayBounds, gapPeriods, gapText, instantOfWall, nextShift, parseIso, shiftText, shiftsBetween, toIso, zoneLabel } from './tz';

const seg = (start: string, end: string): Seg => ({
  id: 's', taskId: 't', projectId: 'p', deviceId: 'd', start: parseIso(start), end: parseIso(end), live: false, remoteOpen: false,
});
const stamp = { at: '2026-01-01T00:00:00Z', by: 'x' };
const shift = (o: Partial<ShiftVersion>): ShiftVersion => ({
  id: 'v', shiftId: 'S', effectiveFrom: '2026-01-01', name: 'Day', color: '#123456', start: '09:00', end: '17:00',
  weekdays: [1, 2, 3, 4, 5, 6, 7], zone: 'UTC', breakMinutes: 0, retired: false, deleted: false, stamp, ...o,
});

describe('zone labels and shifts', () => {
  it('labels with abbreviation and the offset in force at that instant', () => {
    expect(zoneLabel('America/New_York', parseIso('2026-07-01T00:00:00Z'))).toBe('New York, EDT, UTC-4');
    expect(zoneLabel('America/New_York', parseIso('2026-01-15T00:00:00Z'))).toBe('New York, EST, UTC-5');
    expect(zoneLabel('Asia/Kathmandu', parseIso('2026-01-15T00:00:00Z'))).toBe('Kathmandu, UTC+5:45, UTC+5:45');
    expect(zoneLabel('UTC', 0)).toBe('UTC');
  });

  it('names both 2026 switch dates and finds none in zones without DST', () => {
    const y0 = parseIso('2026-01-01T00:00:00Z');
    const y1 = parseIso('2027-01-01T00:00:00Z');
    expect(shiftsBetween(y0, y1, 'America/New_York').map((s) => toIso(s.at))).toEqual(['2026-03-08T07:00:00Z', '2026-11-01T06:00:00Z']);
    expect(shiftsBetween(y0, y1, 'Europe/Lisbon').map((s) => toIso(s.at))).toEqual(['2026-03-29T01:00:00Z', '2026-10-25T01:00:00Z']);
    for (const z of ['America/Phoenix', 'Pacific/Honolulu', 'Asia/Kolkata', 'Asia/Kathmandu', 'UTC']) {
      expect(shiftsBetween(y0, y1, z)).toEqual([]);
    }
    const [spring] = shiftsBetween(y0, y1, 'America/New_York');
    expect(shiftText(spring!)).toContain('New York clocks');
    expect(shiftText(spring!)).toContain('forward 1h, 8 Mar');
    expect(shiftsBetween(y0, y1, 'Australia/Sydney').length).toBe(2);
    expect(shiftsBetween(y0, y1, 'America/Santiago').length).toBe(2);
  });

  it('shows the gap changing in the weeks when US and EU dates differ', () => {
    const y0 = parseIso('2026-01-01T00:00:00Z');
    const y1 = parseIso('2027-01-01T00:00:00Z');
    const periods = gapPeriods(y0, y1, 'Europe/Lisbon', 'America/New_York');
    expect(periods.map((p) => p.gap / 3600)).toEqual([-5, -4, -5, -4, -5]);
    expect(toIso(periods[1]!.start)).toBe('2026-03-08T07:00:00Z');
    expect(toIso(periods[1]!.end)).toBe('2026-03-29T01:00:00Z');
    expect(gapText(parseIso('2026-03-20T12:00:00Z'), 'Europe/Lisbon', 'America/New_York')).toBe('New York is 4h behind you on this date');
    expect(gapText(parseIso('2026-07-20T12:00:00Z'), 'Europe/Lisbon', 'America/New_York')).toBe('New York is 5h behind you on this date');
    expect(nextShift(parseIso('2026-03-01T00:00:00Z'), 'Asia/Kolkata')).toBeNull();
  });

  it('resolves a skipped hour and a repeated hour', () => {
    expect(toIso(instantOfWall('2026-03-08', 150, 'America/New_York'))).toBe('2026-03-08T07:00:00Z');
    expect(toIso(instantOfWall('2026-11-01', 90, 'America/New_York'))).toBe('2026-11-01T05:30:00Z');
    expect(dayBounds('2026-11-01', 'America/New_York').length).toBe(25 * 3600);
  });
});

describe('band splitting', () => {
  it('cuts at bands and midnight, and band totals sum to the whole', () => {
    const pieces = splitAll([seg('2026-07-01T17:00:00Z', '2026-07-02T07:00:00Z')], 'UTC');
    expect(pieces.map((p) => [p.day, BANDS[p.band], p.end - p.start])).toEqual([
      ['2026-07-01', 'Afternoon', 3600],
      ['2026-07-01', 'Evening', 6 * 3600],
      ['2026-07-02', 'Night', 6 * 3600],
      ['2026-07-02', 'Morning', 3600],
    ]);
  });

  it('follows the zone and handles half-hour offsets', () => {
    const pieces = splitAll([seg('2026-07-01T00:00:00Z', '2026-07-01T01:00:00Z')], 'Asia/Kolkata');
    // 00:00Z is 05:30 in India, so the 06:00 band boundary falls at 00:30Z.
    expect(pieces.map((p) => [BANDS[p.band], p.end - p.start])).toEqual([['Night', 1800], ['Morning', 1800]]);
    const b = new BandClock('Asia/Kolkata').bounds('2026-07-01');
    expect(toIso(b[1]!)).toBe('2026-07-01T00:30:00Z');
  });

  it('a 25-hour day can total 25 hours, with the Night band holding the extra one', () => {
    const pieces = splitAll([seg('2026-11-01T04:00:00Z', '2026-11-02T05:00:00Z')], 'America/New_York');
    expect(pieces.reduce((n, p) => n + p.end - p.start, 0)).toBe(25 * 3600);
    expect(pieces.filter((p) => p.band === 0 && p.day === '2026-11-01').reduce((n, p) => n + p.end - p.start, 0)).toBe(7 * 3600);
  });

  it('a 23-hour day has a shorter Night band', () => {
    const pieces = splitAll([seg('2026-03-08T05:00:00Z', '2026-03-09T04:00:00Z')], 'America/New_York');
    expect(pieces.reduce((n, p) => n + p.end - p.start, 0)).toBe(23 * 3600);
    expect(pieces.filter((p) => p.band === 0).reduce((n, p) => n + p.end - p.start, 0)).toBe(5 * 3600);
  });

  it('keeps a zero-length segment as one empty piece', () => {
    expect(splitAll([seg('2026-07-01T10:00:00Z', '2026-07-01T10:00:00Z')], 'UTC').length).toBe(1);
  });
});

describe('shifts', () => {
  const week0 = parseIso('2026-07-06T00:00:00Z');
  const week1 = parseIso('2026-07-13T00:00:00Z');

  it('builds an overnight window on the date it starts', () => {
    const w = windowsFor([shift({ start: '22:00', end: '06:00', weekdays: [1] })], week0, week1);
    expect(w.map((x) => [x.day, toIso(x.start), toIso(x.end)])).toEqual([['2026-07-06', '2026-07-06T22:00:00Z', '2026-07-07T06:00:00Z']]);
  });

  it('follows its own zone through DST, giving 9h and 7h shifts on change nights', () => {
    const night = shift({ start: '22:00', end: '06:00', weekdays: [6], zone: 'America/New_York' });
    const fall = windowsFor([night], parseIso('2026-10-31T00:00:00Z'), parseIso('2026-11-02T00:00:00Z'));
    expect(fall.find((w) => w.day === '2026-10-31')?.scheduledSecs).toBe(9 * 3600);
    const spring = windowsFor([night], parseIso('2026-03-07T00:00:00Z'), parseIso('2026-03-09T00:00:00Z'));
    expect(spring.find((w) => w.day === '2026-03-07')?.scheduledSecs).toBe(7 * 3600);
    // Same New York shift, different UTC instants across the year.
    const day = shift({ zone: 'America/New_York', weekdays: [3] });
    const [jan] = windowsFor([day], parseIso('2026-01-14T00:00:00Z'), parseIso('2026-01-15T00:00:00Z'));
    const [jul] = windowsFor([day], parseIso('2026-07-15T00:00:00Z'), parseIso('2026-07-16T00:00:00Z'));
    expect(toIso(jan!.start)).toBe('2026-01-14T14:00:00Z');
    expect(toIso(jul!.start)).toBe('2026-07-15T13:00:00Z');
  });

  it('applies breaks to scheduled time', () => {
    const [w] = windowsFor([shift({ breakMinutes: 30, weekdays: [1] })], week0, week1);
    expect(w?.scheduledSecs).toBe(7.5 * 3600);
  });

  it('keeps history: an edit with a later effective date leaves earlier dates alone', () => {
    const versions = [shift({ id: 'a', start: '09:00' }), shift({ id: 'b', effectiveFrom: '2026-07-08', start: '10:00' })];
    expect(versionOn(versions, '2026-07-07')?.id).toBe('a');
    expect(versionOn(versions, '2026-07-08')?.id).toBe('b');
    const w = windowsFor(versions, parseIso('2026-07-07T00:00:00Z'), parseIso('2026-07-09T00:00:00Z'));
    expect(w.map((x) => toIso(x.start))).toEqual(['2026-07-07T09:00:00Z', '2026-07-08T10:00:00Z']);
    const retired = [shift({ id: 'a' }), shift({ id: 'c', effectiveFrom: '2026-07-08', retired: true })];
    expect(versionOn(retired, '2026-07-08')).toBeNull();
  });

  it('splits work at shift boundaries with time outside shifts', () => {
    const w = windowsFor([shift({ weekdays: [1] })], week0, week1);
    const parts = attributeSpan(parseIso('2026-07-06T08:00:00Z'), parseIso('2026-07-06T18:00:00Z'), w);
    expect(parts.map((p) => [p.window?.name ?? null, p.end - p.start])).toEqual([[null, 3600], ['Day', 8 * 3600], [null, 3600]]);
  });

  it('never double-counts overlapping shifts: the earliest started owns the overlap', () => {
    const w = windowsFor(
      [
        shift({ id: 'a', shiftId: 'A', name: 'Early', start: '08:00', end: '12:00', weekdays: [1] }),
        shift({ id: 'b', shiftId: 'B', name: 'Late', start: '10:00', end: '14:00', weekdays: [1] }),
      ],
      week0,
      week1,
    );
    const parts = attributeSpan(parseIso('2026-07-06T09:00:00Z'), parseIso('2026-07-06T13:00:00Z'), w);
    expect(parts.map((p) => [p.window?.name, p.end - p.start])).toEqual([['Early', 3 * 3600], ['Late', 3600]]);
    expect(parts.reduce((n, p) => n + p.end - p.start, 0)).toBe(4 * 3600);
  });

  it('no shifts: everything is outside', () => {
    expect(attributeSpan(0, 100, [])).toEqual([{ start: 0, end: 100, window: null }]);
    expect(windowsFor([], 0, 100)).toEqual([]);
  });
});

describe('color', () => {
  it('computed text reaches AA on every palette colour and on arbitrary colours', () => {
    for (const c of [...PROJECT_PALETTE, '#000000', '#ffffff', '#777777', '#fde047', '#123456']) {
      expect(contrast(c, readableText(c))).toBeGreaterThanOrEqual(4.5);
    }
  });

  it('suggests an unused colour', () => {
    expect(suggestColor([])).toBe(PROJECT_PALETTE[0]);
    expect(suggestColor([PROJECT_PALETTE[0]])).toBe(PROJECT_PALETTE[1]);
  });
});

describe('theme token contrast table', () => {
  const themes = Object.keys(THEMES) as Theme[];
  it.each(themes)('%s text pairs reach AA 4.5:1', (name) => {
    const t = THEMES[name];
    for (const [a, b, label] of [
      [t.text, t.bg, 'text/bg'],
      [t.text, t.surface, 'text/surface'],
      [t.text, t.surfaceAlt, 'text/surfaceAlt'],
      [t.textMuted, t.bg, 'muted/bg'],
      [t.textMuted, t.surface, 'muted/surface'],
      [t.onAccent, t.accent, 'onAccent/accent'],
      [t.danger, t.surface, 'danger/surface'],
      [t.warning, t.surface, 'warning/surface'],
      [t.success, t.surface, 'success/surface'],
    ] as const) {
      expect(contrast(a, b), `${name} ${label}`).toBeGreaterThanOrEqual(4.5);
    }
  });

  it.each(themes)('%s marks and controls reach 3:1 against the background', (name) => {
    const t = THEMES[name];
    for (const [c, label] of [
      [t.cWorked, 'worked'], [t.cPaused, 'paused'], [t.cTarget, 'target'], [t.cPrevious, 'previous'], [t.cOutside, 'outside'],
      [t.axis, 'axis'], [t.focus, 'focus'], [t.borderStrong, 'borderStrong'], [t.accent, 'accent'],
    ] as const) {
      expect(contrast(c, t.surface), `${name} ${label}`).toBeGreaterThanOrEqual(3);
    }
  });

  it.each(themes)('%s heat ramp is monotonic in lightness', (name) => {
    const ls = THEMES[name].heat.map(luminance);
    const rising = ls[ls.length - 1]! > ls[0]!;
    for (let i = 1; i < ls.length; i += 1) {
      if (rising) expect(ls[i]!).toBeGreaterThan(ls[i - 1]!);
      else expect(ls[i]!).toBeLessThan(ls[i - 1]!);
    }
  });
});

describe('shiftText tense follows the clock it is given', () => {
  afterEach(() => vi.useRealTimers());
  const [spring] = shiftsBetween(parseIso('2026-01-01T00:00:00Z'), parseIso('2027-01-01T00:00:00Z'), 'Europe/Lisbon');

  it('says "go forward" for a future change and "went forward" for a past one under a frozen clock', () => {
    expect(toIso(spring!.at)).toBe('2026-03-29T01:00:00Z');
    vi.useFakeTimers({ now: new Date('2026-03-12T15:20:00Z') });
    expect(shiftText(spring!)).toBe('Lisbon clocks go forward 1h, 29 Mar');
    vi.setSystemTime(new Date('2026-04-02T00:00:00Z'));
    expect(shiftText(spring!)).toBe('Lisbon clocks went forward 1h, 29 Mar');
  });

  it('uses the passed clock rather than the system clock', () => {
    vi.useFakeTimers({ now: new Date('2030-01-01T00:00:00Z') }); // system clock says it is long past
    expect(shiftText(spring!, parseIso('2026-03-12T15:20:00Z'))).toBe('Lisbon clocks go forward 1h, 29 Mar');
    expect(shiftText(spring!, parseIso('2026-03-30T00:00:00Z'))).toBe('Lisbon clocks went forward 1h, 29 Mar');
  });
});
