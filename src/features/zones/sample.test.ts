import { describe, expect, it } from 'vitest';

import { WORLD_H, WORLD_W } from './geo';
import { sampleZoneMask } from './sample';
import { fitView, geoToScreen, zoomAbout } from './viewport';

const W = 1000;
const H = (W * WORLD_H) / WORLD_W;

const alphaAt = (m: { w: number; data: Uint8ClampedArray }, x: number, y: number, step: number): number =>
  m.data[(Math.floor(y / step) * m.w + Math.floor(x / step)) * 4 + 3] ?? 0;

describe('viewport-resolution zone mask', () => {
  it('marks the samples inside the zone and only those', () => {
    const view = fitView(W, H);
    const m = sampleZoneMask('America/New_York', view, { w: W, h: H }, 2);
    expect(m.w).toBe(500);
    expect(m.data.length).toBe(m.w * m.h * 4);
    const ny = geoToScreen(view, W, 40.7128, -74.006);
    const chicago = geoToScreen(view, W, 41.8781, -87.6298);
    const lisbon = geoToScreen(view, W, 38.7223, -9.1393);
    expect(alphaAt(m, ny.x, ny.y, 2)).toBe(255);
    expect(alphaAt(m, chicago.x, chicago.y, 2)).toBe(0);
    expect(alphaAt(m, lisbon.x, lisbon.y, 2)).toBe(0);
    let lit = 0;
    for (let i = 3; i < m.data.length; i += 4) if (m.data[i] === 255) lit += 1;
    expect(lit).toBeGreaterThan(300);
  });

  it('keeps the zone edge where the pointer sees it when zoomed in', () => {
    // Zoomed on the Colorado/Utah state line: Denver's zone covers one side, Phoenix's (Arizona) another.
    const view = zoomAbout(fitView(W, H), 20, geoToScreen(fitView(W, H), W, 38, -110).x, geoToScreen(fitView(W, H), W, 38, -110).y, W, H);
    const denver = sampleZoneMask('America/Denver', view, { w: W, h: H }, 2);
    const phoenix = sampleZoneMask('America/Phoenix', view, { w: W, h: H }, 2);
    const inDenver = geoToScreen(view, W, 38.5, -108);
    const inPhoenix = geoToScreen(view, W, 34.0, -111.5);
    expect(alphaAt(denver, inDenver.x, inDenver.y, 2)).toBe(255);
    expect(alphaAt(phoenix, inDenver.x, inDenver.y, 2)).toBe(0);
    expect(alphaAt(phoenix, inPhoenix.x, inPhoenix.y, 2)).toBe(255);
    expect(alphaAt(denver, inPhoenix.x, inPhoenix.y, 2)).toBe(0);
  });
});
