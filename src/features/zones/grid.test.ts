import { describe, expect, it } from 'vitest';

import { lookupZone } from './geo';
import { buildGrid, buildGridSync, GRID_NX, GRID_NY, GRID_STEP } from './grid';

const grid = buildGridSync();
const cellOf = (lat: number, lon: number): [number, number] => [Math.floor((90 - lat) / GRID_STEP), Math.floor((lon + 180) / GRID_STEP)];

describe('zone lookup grid', () => {
  it('has the documented 0.5 degree geometry', () => {
    expect(GRID_NX).toBe(720);
    expect(GRID_NY).toBe(360);
    expect(grid.ids.length).toBe(720 * 360);
    expect(grid.rowsFilled).toBe(360);
  });

  it('classifies the cell of known places and leaves open ocean empty', () => {
    expect(grid.zoneAtCell(...cellOf(40.7128, -74.006))).toBe('America/New_York');
    expect(grid.zoneAtCell(...cellOf(38.7223, -9.1393))).toBe('Europe/Lisbon');
    expect(grid.zoneAtCell(...cellOf(35.6762, 139.6503))).toBe('Asia/Tokyo');
    expect(grid.zoneAtCell(...cellOf(0, -30))).toBeNull();
  });

  it('builds a mask with alpha only inside the zone', () => {
    const mask = grid.maskFor('America/Phoenix');
    expect(mask).not.toBeNull();
    const [r, c] = cellOf(33.4484, -112.074);
    expect(mask?.[(r * GRID_NX + c) * 4 + 3]).toBe(255);
    const [r2, c2] = cellOf(41.8781, -87.6298); // Chicago
    expect(mask?.[(r2 * GRID_NX + c2) * 4 + 3]).toBe(0);
    let cells = 0;
    for (let i = 3; i < (mask?.length ?? 0); i += 4) if (mask?.[i] === 255) cells += 1;
    // Arizona is about 295,000 km2, roughly 100 cells of 0.5 x 0.5 degrees at that latitude.
    expect(cells).toBeGreaterThan(60);
    expect(cells).toBeLessThan(160);
    expect(grid.maskFor('Not/AZone')).toBeNull();
    expect(grid.maskFor('America/Phoenix')).toBe(mask);
  });

  it('anchors every zone it holds inside that zone, including ones that cross the antimeridian', () => {
    expect(grid.names.length).toBeGreaterThan(300);
    for (const zone of grid.names.slice(1)) {
      const a = grid.anchor(zone);
      expect(a, zone).not.toBeNull();
      expect(lookupZone(a?.lat ?? 0, a?.lon ?? 0), zone).toBe(zone);
    }
    expect(grid.anchor('Pacific/Fiji')).not.toBeNull();
    expect(grid.anchor('Not/AZone')).toBeNull();
  });

  it('gives the same cells when built in slices off the main path', async () => {
    const sliced = await buildGrid();
    expect(sliced.rowsFilled).toBe(360);
    expect(sliced.names).toEqual(grid.names);
    expect(Buffer.from(sliced.ids.buffer).equals(Buffer.from(grid.ids.buffer))).toBe(true);
  });
});
