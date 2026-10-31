// A coarse lookup grid (0.5 degree cells) of which named zone covers each cell. It backs the highlight
// mask and the pins of zones that have no listed city. Built lazily, in slices, after the map mounts.
import { lookupZone } from './geo';

export const GRID_STEP = 0.5;
export const GRID_NX = 360 / GRID_STEP;
export const GRID_NY = 180 / GRID_STEP;

export class ZoneGrid {
  /** Zone names by id; id 0 means "no named zone" (open ocean). */
  readonly names: string[] = [''];
  /** Row 0 is the northernmost row. */
  readonly ids = new Uint16Array(GRID_NX * GRID_NY);
  private readonly index = new Map<string, number>();
  private readonly cache = new Map<string, Uint8ClampedArray<ArrayBuffer>>();
  private filled = 0;

  get rowsFilled(): number {
    return this.filled;
  }

  /** Looks up rows `[from, to)` at cell centres. */
  fillRows(from: number, to: number): void {
    const end = Math.min(to, GRID_NY);
    for (let r = from; r < end; r += 1) {
      const lat = 90 - (r + 0.5) * GRID_STEP;
      for (let c = 0; c < GRID_NX; c += 1) {
        const zone = lookupZone(lat, -180 + (c + 0.5) * GRID_STEP);
        this.ids[r * GRID_NX + c] = zone === null ? 0 : this.idOf(zone);
      }
    }
    this.filled = Math.max(this.filled, end);
  }

  private idOf(zone: string): number {
    let id = this.index.get(zone);
    if (id === undefined) {
      id = this.names.length;
      this.names.push(zone);
      this.index.set(zone, id);
    }
    return id;
  }

  has(zone: string): boolean {
    return this.index.has(zone);
  }

  /** Zone at a cell, or null for ocean. */
  zoneAtCell(row: number, col: number): string | null {
    const id = this.ids[row * GRID_NX + col];
    return id ? (this.names[id] ?? null) : null;
  }

  /** Alpha-only mask (4 bytes per cell, alpha 255 inside the zone), cached per zone. */
  maskFor(zone: string): Uint8ClampedArray<ArrayBuffer> | null {
    const id = this.index.get(zone);
    if (id === undefined) return null;
    let mask = this.cache.get(zone);
    if (!mask) {
      mask = new Uint8ClampedArray(GRID_NX * GRID_NY * 4);
      for (let i = 0; i < this.ids.length; i += 1) if (this.ids[i] === id) mask[i * 4 + 3] = 255;
      const oldest = this.cache.keys().next();
      if (this.cache.size >= 12 && !oldest.done) this.cache.delete(oldest.value);
      this.cache.set(zone, mask);
    }
    return mask;
  }

  /** The cell of `zone` nearest its centre of mass (circular mean of longitude); null if absent. */
  anchor(zone: string): { lat: number; lon: number } | null {
    const id = this.index.get(zone);
    if (id === undefined) return null;
    let n = 0;
    let sinSum = 0;
    let cosSum = 0;
    let latSum = 0;
    for (let r = 0; r < GRID_NY; r += 1) {
      const lat = 90 - (r + 0.5) * GRID_STEP;
      for (let c = 0; c < GRID_NX; c += 1) {
        if (this.ids[r * GRID_NX + c] !== id) continue;
        const lon = ((-180 + (c + 0.5) * GRID_STEP) * Math.PI) / 180;
        sinSum += Math.sin(lon);
        cosSum += Math.cos(lon);
        latSum += lat;
        n += 1;
      }
    }
    if (n === 0) return null;
    const cLat = latSum / n;
    const cLon = (Math.atan2(sinSum, cosSum) * 180) / Math.PI;
    let best: { lat: number; lon: number } | null = null;
    let bestD = Infinity;
    for (let r = 0; r < GRID_NY; r += 1) {
      const lat = 90 - (r + 0.5) * GRID_STEP;
      for (let c = 0; c < GRID_NX; c += 1) {
        if (this.ids[r * GRID_NX + c] !== id) continue;
        const lon = -180 + (c + 0.5) * GRID_STEP;
        let dLon = Math.abs(lon - cLon);
        if (dLon > 180) dLon = 360 - dLon;
        const d = (lat - cLat) ** 2 + (dLon * Math.cos((lat * Math.PI) / 180)) ** 2;
        if (d < bestD) {
          bestD = d;
          best = { lat, lon };
        }
      }
    }
    return best;
  }
}

export function buildGridSync(): ZoneGrid {
  const grid = new ZoneGrid();
  grid.fillRows(0, GRID_NY);
  return grid;
}

const SLICE_ROWS = 40;
const nextTurn = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

/** Builds the grid in slices of rows, yielding between slices so the page stays responsive. */
export async function buildGrid(): Promise<ZoneGrid> {
  const grid = new ZoneGrid();
  for (let r = 0; r < GRID_NY; r += SLICE_ROWS) {
    grid.fillRows(r, r + SLICE_ROWS);
    await nextTurn();
  }
  return grid;
}

let shared: Promise<ZoneGrid> | null = null;
/** One grid per page load, built on first use. */
export function sharedGrid(): Promise<ZoneGrid> {
  shared ??= buildGrid();
  return shared;
}
