// Geometry and coordinate lookups for the zone map. The map is an equirectangular projection (plain
// longitude and latitude), which keeps clicks exactly invertible and makes no choice about how the
// world "should" look. World units are hundredths of a degree.
import tzlookup from '@photostructure/tz-lookup';

import { isZone } from '../../lib/tz';

export const UNITS_PER_DEG = 100;
/** Top and bottom latitude of the drawn map. Antarctica is left out; its zones stay in the list. */
export const LAT_MAX = 84;
export const LAT_MIN = -60;
export const WORLD_W = 360 * UNITS_PER_DEG;
export const WORLD_H = (LAT_MAX - LAT_MIN) * UNITS_PER_DEG;

/** A zone the picker can return: in the zone database, and not one of the Etc/* ocean bands. */
export function isNamedZone(name: string): boolean {
  return !name.startsWith('Etc/') && isZone(name);
}

const wrapLon = (lon: number): number => {
  const w = ((((lon + 180) % 360) + 360) % 360) - 180;
  return w === -180 && lon > 0 ? 180 : w;
};

/** The named zone containing a point, or null over open ocean (where the data returns Etc/*). */
export function lookupZone(lat: number, lon: number): string | null {
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  const la = Math.max(-90, Math.min(90, lat));
  try {
    const name = tzlookup(la, wrapLon(lon));
    return isNamedZone(name) ? name : null;
  } catch {
    return null;
  }
}

export interface Resolved {
  zone: string;
  /** True when the point itself is open ocean and the zone was found by searching outward. */
  viaRing: boolean;
  /** Radius, in degrees of arc, at which the zone was found; 0 for a direct hit. */
  ringDeg: number;
}

const MAX_RING_DEG = 30;

/**
 * Click-to-zone. A point on land (or in a zone's coastal waters) answers directly. For open ocean the
 * search widens in rings and returns the zone found most often on the first ring that hits anything.
 */
export function resolveZone(lat: number, lon: number, maxRingDeg = MAX_RING_DEG): Resolved | null {
  const direct = lookupZone(lat, lon);
  if (direct) return { zone: direct, viaRing: false, ringDeg: 0 };
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  const cosLat = Math.max(0.15, Math.cos((lat * Math.PI) / 180));
  for (let r = 0.5; r <= maxRingDeg; r += r < 6 ? 0.5 : 1.5) {
    const n = Math.max(16, Math.ceil(r * 8));
    const votes = new Map<string, number>();
    for (let i = 0; i < n; i += 1) {
      const a = (2 * Math.PI * i) / n;
      const la = lat + r * Math.sin(a);
      if (la < -90 || la > 90) continue;
      const z = lookupZone(la, lon + (r * Math.cos(a)) / cosLat);
      if (z) votes.set(z, (votes.get(z) ?? 0) + 1);
    }
    let best: string | null = null;
    let bestVotes = 0;
    for (const [z, v] of votes) {
      if (v > bestVotes) {
        best = z;
        bestVotes = v;
      }
    }
    if (best) return { zone: best, viaRing: true, ringDeg: r };
  }
  return null;
}

/** World x, y (hundredths of a degree from the top-left corner of the drawn map). */
export const toWorld = (lat: number, lon: number): { x: number; y: number } => ({
  x: (lon + 180) * UNITS_PER_DEG,
  y: (LAT_MAX - lat) * UNITS_PER_DEG,
});

export const fromWorld = (x: number, y: number): { lat: number; lon: number } => ({
  lat: LAT_MAX - y / UNITS_PER_DEG,
  lon: x / UNITS_PER_DEG - 180,
});

export interface CityPin {
  name: string;
  zone: string;
  lat: number;
  lon: number;
}

/** Major cities pinned on the map. Each one's coordinates resolve to its own zone (tested). */
export const CITY_PINS: readonly CityPin[] = [
  { name: 'New York', zone: 'America/New_York', lat: 40.71, lon: -74.01 },
  { name: 'Chicago', zone: 'America/Chicago', lat: 41.88, lon: -87.63 },
  { name: 'Denver', zone: 'America/Denver', lat: 39.74, lon: -104.99 },
  { name: 'Los Angeles', zone: 'America/Los_Angeles', lat: 34.05, lon: -118.24 },
  { name: 'Phoenix', zone: 'America/Phoenix', lat: 33.45, lon: -112.07 },
  { name: 'Honolulu', zone: 'Pacific/Honolulu', lat: 21.31, lon: -157.86 },
  { name: 'London', zone: 'Europe/London', lat: 51.51, lon: -0.13 },
  { name: 'Lisbon', zone: 'Europe/Lisbon', lat: 38.72, lon: -9.14 },
  { name: 'Paris', zone: 'Europe/Paris', lat: 48.86, lon: 2.35 },
  { name: 'Berlin', zone: 'Europe/Berlin', lat: 52.52, lon: 13.4 },
  { name: 'Kolkata', zone: 'Asia/Kolkata', lat: 22.57, lon: 88.36 },
  { name: 'Kathmandu', zone: 'Asia/Kathmandu', lat: 27.72, lon: 85.32 },
  { name: 'Tokyo', zone: 'Asia/Tokyo', lat: 35.68, lon: 139.69 },
  { name: 'Sydney', zone: 'Australia/Sydney', lat: -33.87, lon: 151.21 },
  { name: 'Santiago', zone: 'America/Santiago', lat: -33.45, lon: -70.67 },
  { name: 'Sao Paulo', zone: 'America/Sao_Paulo', lat: -23.55, lon: -46.63 },
  { name: 'Johannesburg', zone: 'Africa/Johannesburg', lat: -26.2, lon: 28.05 },
  { name: 'Dubai', zone: 'Asia/Dubai', lat: 25.2, lon: 55.27 },
];
