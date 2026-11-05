import { describe, expect, it } from 'vitest';

import { DAY_GAP, MIN_DAY_WIDTH, daysThatFit, settleFit, stripOf } from './dayStrip';

// Newest first, as the model lists them. Days without time are not in it.
const days = ['2026-03-12', '2026-03-11', '2026-03-10', '2026-03-09', '2026-03-06', '2026-03-05', '2026-03-04'];

describe('how many days fit', () => {
  it('is at least one, however narrow the strip', () => {
    for (const width of [-50, 0, 1, MIN_DAY_WIDTH - 1, MIN_DAY_WIDTH]) expect(daysThatFit(width)).toBe(1);
  });

  it('adds a day for each column width and gap', () => {
    expect(daysThatFit(2 * MIN_DAY_WIDTH + DAY_GAP - 1)).toBe(1);
    expect(daysThatFit(2 * MIN_DAY_WIDTH + DAY_GAP)).toBe(2);
    expect(daysThatFit(3 * MIN_DAY_WIDTH + 2 * DAY_GAP)).toBe(3);
  });

  it('gives two days to a 1360 px window and three to a 1920 px one', () => {
    // The Timeline is 892 px wide in the first, 1452 px in the second: the window less the task list and the page's padding.
    expect(daysThatFit(892)).toBe(2);
    expect(daysThatFit(1452)).toBe(3);
  });
});

describe('settling the count', () => {
  it('falls as soon as the width no longer holds it, and grows when the room is there', () => {
    expect(settleFit(3, 532)).toBe(1);
    expect(settleFit(2, 855)).toBe(1);
    expect(settleFit(1, 1452)).toBe(3);
  });

  it('does not flip back and forth when a scrollbar comes and goes at a boundary', () => {
    // 860 px holds two days; 845 px, what is left with a 15 px scrollbar, holds one. The page's height decides which.
    let fit = 2;
    const seen: number[] = [];
    for (const width of [860, 845, 860, 845, 860]) {
      fit = settleFit(fit, width);
      seen.push(fit);
    }
    expect(seen).toEqual([2, 1, 1, 1, 1]);
    // A window with room to spare gets the second day back.
    expect(settleFit(1, 900)).toBe(2);
  });
});

describe('the strip of days', () => {
  it('opens on the newest days: the oldest on the left, today on the right', () => {
    const s = stripOf(days, null, 3);
    expect(s.shown).toEqual(['2026-03-10', '2026-03-11', '2026-03-12']);
    expect(s.canLater).toBe(false);
    expect(s.canEarlier).toBe(true);
  });

  it('a step back moves a page, and a step forward moves it back, ending on the newest', () => {
    const back = stripOf(days, null, 3);
    const page2 = stripOf(days, back.earlier, 3);
    expect(page2.shown).toEqual(['2026-03-05', '2026-03-06', '2026-03-09']);
    expect(page2.canLater).toBe(true);
    const forward = stripOf(days, page2.later, 3);
    expect(forward.shown).toEqual(['2026-03-10', '2026-03-11', '2026-03-12']);
    expect(forward.canLater).toBe(false);
    // Forward from the first page ends on null: the strip follows the newest day again.
    expect(page2.later).toBeNull();
  });

  it('stops at the oldest day with the strip still full', () => {
    let s = stripOf(days, null, 3);
    for (let i = 0; i < 5 && s.canEarlier; i += 1) s = stripOf(days, s.earlier, 3);
    expect(s.shown).toEqual(['2026-03-04', '2026-03-05', '2026-03-06']);
    expect(s.canEarlier).toBe(false);
    expect(s.canLater).toBe(true);
    // And a step forward from the clamped page moves a whole page again.
    expect(stripOf(days, s.later, 3).shown).toEqual(['2026-03-09', '2026-03-10', '2026-03-11']);
  });

  it('shows every day, with both arrows off, when they all fit', () => {
    const s = stripOf(days, null, 10);
    expect(s.shown).toEqual([...days].reverse());
    expect([s.canEarlier, s.canLater]).toEqual([false, false]);
  });

  it('pages a day at a time when only one fits', () => {
    const s = stripOf(days, null, 1);
    expect(s.shown).toEqual(['2026-03-12']);
    expect(stripOf(days, s.earlier, 1).shown).toEqual(['2026-03-11']);
    // A count below one is one.
    expect(stripOf(days, null, 0).shown).toEqual(['2026-03-12']);
  });

  it('holds the day at the right edge when a newer day appears, and follows the newest only when it was following', () => {
    const held = stripOf(days, null, 3).earlier;
    const withNew = ['2026-03-13', ...days];
    expect(stripOf(withNew, held, 3).shown).toEqual(['2026-03-05', '2026-03-06', '2026-03-09']);
    expect(stripOf(withNew, null, 3).shown).toEqual(['2026-03-11', '2026-03-12', '2026-03-13']);
  });

  it('copes with a held day that is no longer listed, such as one a filter took away', () => {
    const s = stripOf(['2026-03-12', '2026-03-10', '2026-03-05'], '2026-03-11', 2);
    expect(s.shown).toEqual(['2026-03-05', '2026-03-10']);
  });

  it('has nothing to show, and nowhere to go, for no days', () => {
    expect(stripOf([], null, 3)).toEqual({ shown: [], canEarlier: false, canLater: false, earlier: null, later: null });
  });

  it('leaves the list it is given as it was', () => {
    const frozen = Object.freeze([...days]);
    expect(stripOf(frozen, null, 3).shown).toEqual(['2026-03-10', '2026-03-11', '2026-03-12']);
    expect(frozen).toEqual(days);
  });
});
