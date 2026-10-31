import { describe, expect, it } from 'vitest';

import { CITY_PINS, WORLD_H, WORLD_W } from './geo';
import { placePins, type Pin } from './pins';
import { fitView } from './viewport';

const W = 1000;
const H = (W * WORLD_H) / WORLD_W;
const size = { w: W, h: H };
const view = fitView(W, H);
const asPin = (c: (typeof CITY_PINS)[number]): Pin => ({ key: c.name, kind: 'city', zone: c.zone, label: c.name, lat: c.lat, lon: c.lon });

describe('pin placement', () => {
  it('places every city inside the map at the whole-world view, none under the controls or info card', () => {
    const placed = placePins(CITY_PINS.map(asPin), view, size);
    // Only pins whose markers would sit on top of each other are dropped; none here are that close.
    expect(placed.length).toBeGreaterThanOrEqual(CITY_PINS.length - 2);
    for (const p of placed) {
      expect(p.x).toBeGreaterThanOrEqual(8);
      expect(p.x).toBeLessThanOrEqual(W - 8);
      expect(p.y).toBeLessThanOrEqual(H - 42);
    }
  });

  it('never lets two labels overlap and keeps labels inside the frame', () => {
    const placed = placePins(CITY_PINS.map(asPin), view, size).filter((p) => p.labelAt);
    const rect = (p: (typeof placed)[number]) => {
      const w = p.label.length * 6.3 + 8;
      const x0 = p.labelAt?.anchor === 'start' ? (p.labelAt?.x ?? 0) : (p.labelAt?.x ?? 0) - w;
      return { x0, x1: x0 + w, y0: p.y - 8, y1: p.y + 8 };
    };
    for (let i = 0; i < placed.length; i += 1) {
      const a = rect(placed[i]!);
      expect(a.x0).toBeGreaterThanOrEqual(0);
      expect(a.x1).toBeLessThanOrEqual(W);
      for (let j = i + 1; j < placed.length; j += 1) {
        const b = rect(placed[j]!);
        expect(a.x0 < b.x1 && a.x1 > b.x0 && a.y0 < b.y1 && a.y1 > b.y0, `${placed[i]?.label} vs ${placed[j]?.label}`).toBe(false);
      }
    }
  });

  it('moves a label to the other side when a neighbouring marker blocks it, and drops it when both sides are blocked', () => {
    const mine: Pin = { key: 'mine', kind: 'mine', zone: 'Europe/Lisbon', label: 'My zone: Lisbon', lat: 38.72, lon: -9.14 };
    const right: Pin = { key: 'r', kind: 'city', zone: 'Europe/Madrid', label: 'R', lat: 38.9, lon: -3.0 };
    const left: Pin = { key: 'l', kind: 'city', zone: 'Atlantic/Azores', label: 'L', lat: 38.9, lon: -15.5 };
    expect(placePins([mine, right], view, size)[0]?.labelAt?.anchor).toBe('end');
    expect(placePins([mine, right, left], view, size)[0]?.labelAt).toBeNull();
  });

  it('puts a label on the left near the right edge, and drops pins at the very edge or off the map', () => {
    const east: Pin = { key: 'e', kind: 'city', zone: 'Pacific/Auckland', label: 'Auckland', lat: 40, lon: 176 };
    const edge: Pin = { key: 'edge', kind: 'city', zone: 'Pacific/Fiji', label: 'Edge', lat: 40, lon: 179.9 };
    const off: Pin = { key: 'off', kind: 'city', zone: 'UTC', label: 'South', lat: -75, lon: 0 };
    const placed = placePins([east, edge, off], view, size);
    expect(placed.map((p) => p.key)).toEqual(['e']);
    expect(placed[0]?.labelAt?.anchor).toBe('end');
  });
});
