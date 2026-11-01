import { describe, expect, it } from 'vitest';

import { EMPTY_SELECTION, announce, entryOf, keyOf, prune, selectAll, selectOnly, selectRange, toEntries, toggle } from './selectionLogic';

const order = ['a|2026-03-12', 'b|2026-03-12', 'a|2026-03-11', 'c|2026-03-11', 'b|2026-03-10'];

describe('selection rules', () => {
  it('a plain click selects only that task-day and makes it the anchor', () => {
    const s = selectOnly(order[1] as string);
    expect(s).toEqual({ keys: ['b|2026-03-12'], anchor: 'b|2026-03-12' });
    expect(selectOnly(order[3] as string).keys).toEqual(['c|2026-03-11']);
  });

  it('Ctrl+click adds and removes, in any order, without needing neighbours', () => {
    let s = selectOnly(order[0] as string);
    s = toggle(s, order[3] as string);
    s = toggle(s, order[4] as string);
    expect(s.keys).toEqual([order[0], order[3], order[4]]);
    s = toggle(s, order[3] as string);
    expect(s.keys).toEqual([order[0], order[4]]);
    expect(toggle(EMPTY_SELECTION, order[2] as string).keys).toEqual([order[2]]);
  });

  it('Shift+click selects the range from the anchor in screen order, across days, either way round', () => {
    const s = selectRange(selectOnly(order[1] as string), order[3] as string, order);
    expect(s.keys).toEqual([order[1], order[2], order[3]]);
    expect(s.anchor).toBe(order[1]);
    expect(selectRange(selectOnly(order[3] as string), order[0] as string, order).keys).toEqual([order[0], order[1], order[2], order[3]]);
    // Shifting again moves only the far end.
    expect(selectRange(s, order[4] as string, order).keys).toEqual([order[1], order[2], order[3], order[4]]);
    expect(selectRange(s, order[1] as string, order).keys).toEqual([order[1]]);
  });

  it('Ctrl+Shift keeps what was chosen and adds the range', () => {
    let s = selectOnly(order[0] as string);
    s = toggle(s, order[3] as string);
    expect(selectRange(s, order[4] as string, order, true).keys).toEqual([order[0], order[3], order[4]]);
  });

  it('a Shift range with no anchor, or to something not on screen, is safe', () => {
    expect(selectRange(EMPTY_SELECTION, order[2] as string, order).keys).toEqual([order[2]]);
    const s = selectOnly(order[0] as string);
    expect(selectRange(s, 'gone|2026-01-01', order)).toBe(s);
  });

  it('Ctrl+A adds everything on screen to what is chosen', () => {
    const s = selectAll(selectOnly('x|2026-01-01'), order);
    expect(s.keys).toEqual(['x|2026-01-01', ...order]);
    expect(selectAll(EMPTY_SELECTION, order).anchor).toBe(order[0]);
  });

  it('prunes what no longer exists and keeps the anchor sensible', () => {
    const s = toggle(selectOnly(order[0] as string), order[1] as string);
    expect(prune(s, new Set(order)).keys).toEqual(s.keys);
    const p = prune(s, new Set([order[0] as string]));
    expect(p.keys).toEqual([order[0]]);
    expect(p.anchor).toBe(order[0]);
  });

  it('round-trips keys and sends a stable list: newest day first, then task id', () => {
    expect(entryOf(keyOf('t-1', '2026-03-12'))).toEqual({ taskId: 't-1', day: '2026-03-12' });
    expect(toEntries(['b|2026-03-10', 'a|2026-03-12', 'b|2026-03-12'])).toEqual([
      { taskId: 'a', day: '2026-03-12' },
      { taskId: 'b', day: '2026-03-12' },
      { taskId: 'b', day: '2026-03-10' },
    ]);
  });

  it('words the live region', () => {
    expect(announce(0, 0)).toBe('Selection cleared');
    expect(announce(1, 0)).toBe('1 task selected');
    expect(announce(3, 2)).toBe('3 tasks selected, 2 not on screen');
  });
});
