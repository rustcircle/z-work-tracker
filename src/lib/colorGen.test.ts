import { describe, expect, it } from 'vitest';

import { PROJECT_PALETTE, THEME_BACKGROUNDS, contrast, distance, distinctColor, fromOklch, suggestColor } from './color';
import { THEMES } from './themes';

/** mulberry32: a seeded generator, the way tests inject randomness. */
function seeded(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

describe('the colour generator (a port of colors.rs)', () => {
  it('uses the backgrounds the themes use, so both sides judge readability alike', () => {
    const all = new Set(Object.values(THEMES).flatMap((t) => [t.bg, t.surface, t.surfaceAlt]));
    for (const bg of THEME_BACKGROUNDS) expect(all.has(bg), bg).toBe(true);
    expect(THEME_BACKGROUNDS).toHaveLength(7);
  });

  it('converts OKLCH to sRGB and measures distance as the backend does', () => {
    expect(fromOklch(0, 0, 0)).toBe('#000000');
    expect(fromOklch(1, 0, 0)).toBe('#ffffff');
    expect(fromOklch(0.6, 0.9, 30)).toBeNull();
    expect(distance('#2563eb', '#2563eb')).toBeLessThan(1e-9);
    expect(distance('#000000', '#ffffff')).toBeGreaterThan(0.9);
    expect(distance('nope', '#ffffff')).toBe(Number.MAX_VALUE);
  });

  it('never repeats and stays readable on all four themes as the store fills', () => {
    const random = seeded(1);
    const taken: string[] = [];
    for (let i = 0; i < 60; i += 1) {
      const hex = distinctColor(taken, random);
      expect(taken, `${hex} repeated`).not.toContain(hex);
      expect(hex).toMatch(/^#[0-9a-f]{6}$/);
      for (const bg of THEME_BACKGROUNDS) expect(contrast(hex, bg), `${hex} on ${bg}`).toBeGreaterThanOrEqual(2);
      taken.push(hex);
    }
  });

  it('keeps the first colours clearly apart', () => {
    const random = seeded(2);
    const taken = ['#2563eb', '#dc2626'];
    for (let i = 0; i < 8; i += 1) {
      const hex = distinctColor(taken, random);
      expect(Math.min(...taken.map((t) => distance(t, hex)))).toBeGreaterThanOrEqual(0.09);
      taken.push(hex);
    }
  });

  it('terminates when nothing random comes out', () => {
    expect(distinctColor([], () => 0)).toMatch(/^#[0-9a-f]{6}$/);
  });

  it('is deterministic for a given seed', () => {
    expect(distinctColor(['#2563eb'], seeded(9))).toBe(distinctColor(['#2563eb'], seeded(9)));
  });
});

describe('suggestColor falls through to the generator once the palette runs out', () => {
  it('hands out the curated colours in order, then generated ones that never repeat', () => {
    const random = seeded(3);
    const used: string[] = [];
    for (let i = 0; i < PROJECT_PALETTE.length + 20; i += 1) {
      const c = suggestColor(used, random);
      expect(used.map((u) => u.toLowerCase())).not.toContain(c);
      if (i < PROJECT_PALETTE.length) expect(c).toBe(PROJECT_PALETTE[i]);
      used.push(c);
    }
    expect(new Set(used).size).toBe(used.length);
  });

  it('treats the colours in use case-insensitively', () => {
    expect(suggestColor([PROJECT_PALETTE[0].toUpperCase()])).toBe(PROJECT_PALETTE[1]);
  });
});
