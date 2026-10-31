import { describe, expect, it } from 'vitest';

import { isZone } from '../../lib/tz';
import { CITY_PINS, fromWorld, isNamedZone, lookupZone, resolveZone, toWorld, WORLD_H, WORLD_W } from './geo';
import { clampView, fitView, geoToScreen, panBy, screenToGeo, zoomAbout, MAX_K } from './viewport';

// Coordinates and the zone a person expects there, hand-checked against the places themselves.
const FIXTURES: [string, number, number, string][] = [
  ['New York', 40.7128, -74.006, 'America/New_York'],
  ['Chicago', 41.8781, -87.6298, 'America/Chicago'],
  ['Denver', 39.7392, -104.9903, 'America/Denver'],
  ['Los Angeles', 34.0522, -118.2437, 'America/Los_Angeles'],
  ['Phoenix (no DST)', 33.4484, -112.074, 'America/Phoenix'],
  ['Lisbon', 38.7223, -9.1393, 'Europe/Lisbon'],
  ['Kolkata', 22.5726, 88.3639, 'Asia/Kolkata'],
  ['Kathmandu (UTC+5:45)', 27.7172, 85.324, 'Asia/Kathmandu'],
  ['Honolulu', 21.3069, -157.8583, 'Pacific/Honolulu'],
  ['Tokyo', 35.6762, 139.6503, 'Asia/Tokyo'],
];

describe('coordinate to zone', () => {
  it.each(FIXTURES)('%s resolves to %s', (_name, lat, lon, zone) => {
    expect(lookupZone(lat, lon)).toBe(zone);
    expect(isZone(zone)).toBe(true);
    expect(resolveZone(lat, lon)).toEqual({ zone, viaRing: false, ringDeg: 0 });
  });

  it('answers null over open ocean, then finds the nearest named zone by searching outward', () => {
    // 0N 30W in the equatorial Atlantic is Etc/GMT+2 in the data; the nearest land is Fernando de Noronha.
    expect(lookupZone(0, -30)).toBeNull();
    const r = resolveZone(0, -30);
    expect(r?.zone).toBe('America/Noronha');
    expect(r?.viaRing).toBe(true);
    expect(r?.ringDeg).toBeGreaterThan(0);
    expect(r?.ringDeg).toBeLessThan(8);
  });

  it('gives up when no named zone lies within the search radius', () => {
    // South Pacific, well away from every island: nothing within 3 degrees, so no zone is invented.
    expect(lookupZone(-45, -125)).toBeNull();
    expect(resolveZone(-45, -125, 3)).toBeNull();
    // With the default radius the nearest named zone is found (the data places Easter Island 12 degrees out).
    expect(resolveZone(-45, -125)).toEqual({ zone: 'Pacific/Easter', viaRing: true, ringDeg: 12 });
  });

  it('never returns an Etc band or a zone the app cannot use', () => {
    for (let lat = -60; lat <= 80; lat += 7) {
      for (let lon = -180; lon <= 180; lon += 9) {
        const z = lookupZone(lat, lon);
        if (z !== null) {
          expect(z.startsWith('Etc/')).toBe(false);
          expect(isNamedZone(z)).toBe(true);
        }
      }
    }
  });

  it('rejects non-finite input and wraps longitudes past the antimeridian', () => {
    expect(lookupZone(Number.NaN, 0)).toBeNull();
    expect(lookupZone(0, Number.POSITIVE_INFINITY)).toBeNull();
    expect(resolveZone(Number.NaN, 0)).toBeNull();
    expect(lookupZone(40.7128, -74.006 + 360)).toBe('America/New_York');
    expect(lookupZone(95, -74)).toBe(lookupZone(90, -74));
  });

  it('every pinned city lies in its own zone', () => {
    expect(CITY_PINS.map((p) => p.name)).toEqual(
      expect.arrayContaining(['New York', 'Chicago', 'Denver', 'Los Angeles', 'Phoenix', 'Honolulu', 'London', 'Lisbon', 'Paris', 'Berlin', 'Kolkata', 'Kathmandu', 'Tokyo', 'Sydney', 'Santiago', 'Sao Paulo', 'Johannesburg', 'Dubai']),
    );
    for (const p of CITY_PINS) expect(lookupZone(p.lat, p.lon), p.name).toBe(p.zone);
  });
});

describe('projection and viewport', () => {
  it('round-trips world coordinates and covers the drawn latitudes', () => {
    const w = toWorld(38.7223, -9.1393);
    const back = fromWorld(w.x, w.y);
    expect(back.lat).toBeCloseTo(38.7223, 9);
    expect(back.lon).toBeCloseTo(-9.1393, 9);
    expect(toWorld(84, -180)).toEqual({ x: 0, y: 0 });
    expect(toWorld(-60, 180)).toEqual({ x: WORLD_W, y: WORLD_H });
  });

  it('fits the whole world at zoom 1 and maps a click to the same point it was drawn at', () => {
    const w = 1000;
    const h = (w * WORLD_H) / WORLD_W;
    const v = fitView(w, h);
    expect(v).toEqual({ k: 1, x: 0, y: 0 });
    const p = geoToScreen(v, w, 40.7128, -74.006);
    const g = screenToGeo(v, w, p.x, p.y);
    expect(g.lat).toBeCloseTo(40.7128, 6);
    expect(g.lon).toBeCloseTo(-74.006, 6);
    expect(lookupZone(g.lat, g.lon)).toBe('America/New_York');
  });

  it('zooms about the pointer so the point under it stays put, and clamps at both ends', () => {
    const w = 1000;
    const h = 400;
    const v0 = fitView(w, h);
    const before = screenToGeo(v0, w, 300, 120);
    const v1 = zoomAbout(v0, 4, 300, 120, w, h);
    expect(v1.k).toBe(4);
    const after = screenToGeo(v1, w, 300, 120);
    expect(after.lat).toBeCloseTo(before.lat, 6);
    expect(after.lon).toBeCloseTo(before.lon, 6);
    expect(zoomAbout(v0, 0.1, 10, 10, w, h).k).toBe(1);
    expect(zoomAbout(v1, 1e6, 10, 10, w, h).k).toBe(MAX_K);
  });

  it('keeps the world covering the view while panning', () => {
    const w = 1000;
    const h = 400;
    const v = zoomAbout(fitView(w, h), 8, 500, 200, w, h);
    const far = panBy(v, 1e6, 1e6, w, h);
    expect(far.x).toBe(0);
    expect(far.y).toBe(0);
    const other = panBy(v, -1e6, -1e6, w, h);
    const s = (w / WORLD_W) * v.k;
    expect(other.x).toBeCloseTo(w - WORLD_W * s, 6);
    expect(other.y).toBeCloseTo(h - WORLD_H * s, 6);
    expect(clampView({ k: 2, x: 5, y: 5 }, w, h).x).toBe(0);
  });
});
