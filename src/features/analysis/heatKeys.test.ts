import { describe, expect, it } from 'vitest';

import { dayCellMove, hourCellMove, isActivateKey } from './heatKeys';

describe('hour grid keys', () => {
  it('moves by one cell and stops at the edges', () => {
    expect(hourCellMove('ArrowRight', false, 2, 5, 7)).toEqual({ row: 2, hour: 6 });
    expect(hourCellMove('ArrowLeft', false, 2, 5, 7)).toEqual({ row: 2, hour: 4 });
    expect(hourCellMove('ArrowDown', false, 2, 5, 7)).toEqual({ row: 3, hour: 5 });
    expect(hourCellMove('ArrowUp', false, 2, 5, 7)).toEqual({ row: 1, hour: 5 });
    expect(hourCellMove('ArrowLeft', false, 2, 0, 7)).toBeNull();
    expect(hourCellMove('ArrowRight', false, 2, 23, 7)).toBeNull();
    expect(hourCellMove('ArrowUp', false, 0, 5, 7)).toBeNull();
    expect(hourCellMove('ArrowDown', false, 6, 5, 7)).toBeNull();
  });
  it('Home and End go to the row ends, and with Ctrl to the grid corners', () => {
    expect(hourCellMove('Home', false, 3, 9, 7)).toEqual({ row: 3, hour: 0 });
    expect(hourCellMove('End', false, 3, 9, 7)).toEqual({ row: 3, hour: 23 });
    expect(hourCellMove('Home', true, 3, 9, 7)).toEqual({ row: 0, hour: 0 });
    expect(hourCellMove('End', true, 3, 9, 7)).toEqual({ row: 6, hour: 23 });
    expect(hourCellMove('x', false, 3, 9, 7)).toBeNull();
  });
});

describe('day grid keys', () => {
  it('Up and Down are a day, Left and Right a week, and nothing leaves the range', () => {
    expect(dayCellMove('ArrowDown', 10, 30)).toBe(11);
    expect(dayCellMove('ArrowUp', 10, 30)).toBe(9);
    expect(dayCellMove('ArrowRight', 10, 30)).toBe(17);
    expect(dayCellMove('ArrowLeft', 10, 30)).toBe(3);
    expect(dayCellMove('ArrowLeft', 3, 30)).toBeNull();
    expect(dayCellMove('ArrowRight', 25, 30)).toBeNull();
    expect(dayCellMove('ArrowUp', 0, 30)).toBeNull();
    expect(dayCellMove('ArrowDown', 29, 30)).toBeNull();
    expect(dayCellMove('Home', 12, 30)).toBe(0);
    expect(dayCellMove('End', 12, 30)).toBe(29);
    expect(dayCellMove('Home', 0, 0)).toBeNull();
  });
  it('Enter and Space activate', () => {
    expect(isActivateKey('Enter')).toBe(true);
    expect(isActivateKey(' ')).toBe(true);
    expect(isActivateKey('a')).toBe(false);
  });
});
