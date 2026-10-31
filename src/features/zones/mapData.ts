// Country outlines for the map, from the world-atlas package (Natural Earth, 1:50m) as TopoJSON. The
// data is a bundled chunk that only loads when the picker opens; nothing is fetched at runtime.
import type { feature as featureFn } from 'topojson-client';

import { LAT_MAX, LAT_MIN, UNITS_PER_DEG } from './geo';

type Topology = Parameters<typeof featureFn>[0];

export interface CountryPath {
  id: string;
  /** SVG path data in world units (hundredths of a degree from the map's top-left corner). */
  d: string;
}

function isTopology(x: unknown): x is Topology {
  if (typeof x !== 'object' || x === null) return false;
  const t = x as { type?: unknown; objects?: unknown; arcs?: unknown };
  return t.type === 'Topology' && typeof t.objects === 'object' && t.objects !== null && Array.isArray(t.arcs);
}

type Ring = readonly (readonly number[])[];

function ringsOf(geometry: unknown): Ring[] {
  if (typeof geometry !== 'object' || geometry === null) return [];
  const g = geometry as { type?: unknown; coordinates?: unknown };
  if (!Array.isArray(g.coordinates)) return [];
  if (g.type === 'Polygon') return g.coordinates as Ring[];
  if (g.type === 'MultiPolygon') return (g.coordinates as Ring[][]).flat();
  return [];
}

/** One closed sub-path in relative moves, or null when the ring lies wholly outside the drawn latitudes. */
export function ringToPath(ring: Ring): string | null {
  if (ring.length < 3) return null;
  let minLat = Infinity;
  let maxLat = -Infinity;
  for (const p of ring) {
    const lat = p[1] ?? 0;
    minLat = Math.min(minLat, lat);
    maxLat = Math.max(maxLat, lat);
  }
  if (maxLat < LAT_MIN - 1 || minLat > LAT_MAX + 1) return null;
  let out = '';
  let px = 0;
  let py = 0;
  ring.forEach((p, i) => {
    const x = Math.round(((p[0] ?? 0) + 180) * UNITS_PER_DEG);
    const y = Math.round((LAT_MAX - (p[1] ?? 0)) * UNITS_PER_DEG);
    if (i === 0) out += `M${x} ${y}`;
    else if (x !== px || y !== py) out += `l${x - px} ${y - py}`;
    px = x;
    py = y;
  });
  return `${out}z`;
}

export function topologyToPaths(topology: Topology, feature: typeof featureFn): CountryPath[] {
  const collection: unknown = feature(topology, 'countries');
  const features = (collection as { features?: unknown }).features;
  if (!Array.isArray(features)) throw new Error('countries object has no features');
  const out: CountryPath[] = [];
  features.forEach((f: unknown, i) => {
    const feat = f as { id?: unknown; geometry?: unknown };
    const d = ringsOf(feat.geometry)
      .map(ringToPath)
      .filter((s): s is string => s !== null)
      .join('');
    if (d) out.push({ id: `${String(feat.id ?? 'x')}-${i}`, d });
  });
  return out;
}

let cached: Promise<CountryPath[]> | null = null;

export function loadCountryPaths(): Promise<CountryPath[]> {
  cached ??= (async () => {
    const [{ feature }, atlas] = await Promise.all([import('topojson-client'), import('world-atlas/countries-50m.json')]);
    const topology: unknown = atlas.default;
    if (!isTopology(topology)) throw new Error('countries-50m.json is not a TopoJSON topology');
    return topologyToPaths(topology, feature);
  })();
  cached.catch(() => {
    cached = null; // allow a retry on the next open
  });
  return cached;
}

/** Faint reference lines every 30 degrees, as one path in world units. */
export function graticulePath(): string {
  const w = 360 * UNITS_PER_DEG;
  const h = (LAT_MAX - LAT_MIN) * UNITS_PER_DEG;
  let d = '';
  for (let lon = -150; lon <= 150; lon += 30) d += `M${(lon + 180) * UNITS_PER_DEG} 0v${h}`;
  for (let lat = -30; lat <= 60; lat += 30) d += `M0 ${(LAT_MAX - lat) * UNITS_PER_DEG}h${w}`;
  return d;
}
