import { describe, expect, it } from 'vitest';

import { WORLD_H, WORLD_W } from './geo';
import { graticulePath, loadCountryPaths, ringToPath } from './mapData';

/** Reads absolute vertices back out of the relative path data produced by ringToPath. */
function vertices(d: string): { x: number; y: number }[] {
  const out: { x: number; y: number }[] = [];
  let x = 0;
  let y = 0;
  for (const m of d.matchAll(/([Mlz])(-?\d+)?\s?(-?\d+)?/g)) {
    if (m[1] === 'z') continue;
    const a = Number(m[2]);
    const b = Number(m[3]);
    if (m[1] === 'M') {
      x = a;
      y = b;
    } else {
      x += a;
      y += b;
    }
    out.push({ x, y });
  }
  return out;
}

describe('country geometry', () => {
  it('writes a ring as relative moves in hundredths of a degree', () => {
    const ring = [[-180, 84], [-179, 84], [-179, 83], [-180, 83], [-180, 84]];
    expect(ringToPath(ring)).toBe('M0 0l100 0l0 100l-100 0l0 -100z');
  });

  it('drops repeated points and rings wholly outside the drawn latitudes', () => {
    expect(ringToPath([[0, 0], [0.001, 0.001], [1, 0], [1, 1]])).toBe('M18000 8400l100 0l0 -100z');
    expect(ringToPath([[0, -80], [1, -80], [1, -75]])).toBeNull();
    expect(ringToPath([[0, 0], [1, 1]])).toBeNull();
  });

  it('loads the bundled 1:50m countries as valid paths inside the map', async () => {
    const paths = await loadCountryPaths();
    expect(paths.length).toBeGreaterThan(200);
    expect(new Set(paths.map((p) => p.id)).size).toBe(paths.length);
    let points = 0;
    for (const p of paths) {
      expect(p.d.startsWith('M')).toBe(true);
      expect(p.d).not.toMatch(/NaN|undefined/);
      for (const v of vertices(p.d)) {
        points += 1;
        expect(v.x).toBeGreaterThanOrEqual(0);
        expect(v.x).toBeLessThanOrEqual(WORLD_W);
        expect(v.y).toBeGreaterThanOrEqual(0);
        expect(v.y).toBeLessThanOrEqual(WORLD_H + 600);
      }
    }
    expect(points).toBeGreaterThan(50_000);
  });

  it('draws a reference line every 30 degrees', () => {
    // 11 meridians (150W to 150E) and 4 parallels (30S, equator, 30N, 60N) inside the 60S to 84N map.
    expect(graticulePath().match(/M/g)?.length).toBe(11 + 4);
  });
});
