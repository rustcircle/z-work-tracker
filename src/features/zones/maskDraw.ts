// Paints the zone highlights onto the map's canvas. Over land the colour is strong; over open water the
// zone's (coarse) boundary tiles are only tinted, so they read as an area rather than as blocks.
import { UNITS_PER_DEG } from './geo';
import { GRID_NX, GRID_NY, GRID_STEP, type ZoneGrid } from './grid';
import { sampleZoneMask } from './sample';
import { baseScale, geoToScreen, screenToGeo, type View } from './viewport';

export interface MaskSpec {
  zone: string | null;
  color: string;
  landAlpha: number;
  seaAlpha: number;
}

export interface PaintArgs {
  canvas: HTMLCanvasElement;
  size: { w: number; h: number };
  dpr: number;
  view: View;
  grid: ZoneGrid | null;
  land: Path2D | null;
  masks: readonly MaskSpec[];
}

/** From this zoom on, masks are sampled at screen resolution instead of read from the 0.5 degree grid. */
export const SAMPLE_FROM_K = 3;
const SAMPLE_STEP = 2;

function newCanvas(w: number, h: number): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
}

export class MaskPainter {
  private readonly gridLayers = new Map<string, HTMLCanvasElement>();
  private stencil: HTMLCanvasElement | null = null;
  private scratch: HTMLCanvasElement | null = null;
  private sampled: HTMLCanvasElement | null = null;

  clearCache(): void {
    this.gridLayers.clear();
  }

  private gridLayer(grid: ZoneGrid, zone: string, color: string): HTMLCanvasElement | null {
    const key = `${zone}|${color}`;
    const hit = this.gridLayers.get(key);
    if (hit) return hit;
    const mask = grid.maskFor(zone);
    if (!mask) return null;
    const off = newCanvas(GRID_NX, GRID_NY);
    const ctx = off.getContext('2d');
    if (!ctx) return null;
    ctx.putImageData(new ImageData(mask, GRID_NX, GRID_NY), 0, 0);
    ctx.globalCompositeOperation = 'source-in';
    ctx.fillStyle = color;
    ctx.fillRect(0, 0, GRID_NX, GRID_NY);
    const oldest = this.gridLayers.keys().next();
    if (this.gridLayers.size >= 16 && !oldest.done) this.gridLayers.delete(oldest.value);
    this.gridLayers.set(key, off);
    return off;
  }

  /** Draws the zone into `scratch` (CSS-pixel coordinates). Returns false when nothing could be drawn. */
  private drawZone(ctx: CanvasRenderingContext2D, a: PaintArgs, zone: string, color: string): boolean {
    const { size, view } = a;
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    if (view.k >= SAMPLE_FROM_K) {
      const m = sampleZoneMask(zone, view, size, SAMPLE_STEP);
      this.sampled ??= newCanvas(m.w, m.h);
      if (this.sampled.width !== m.w) this.sampled.width = m.w;
      if (this.sampled.height !== m.h) this.sampled.height = m.h;
      const sctx = this.sampled.getContext('2d');
      if (!sctx) return false;
      sctx.globalCompositeOperation = 'source-over';
      sctx.clearRect(0, 0, m.w, m.h);
      sctx.putImageData(new ImageData(m.data, m.w, m.h), 0, 0);
      sctx.globalCompositeOperation = 'source-in';
      sctx.fillStyle = color;
      sctx.fillRect(0, 0, m.w, m.h);
      ctx.drawImage(this.sampled, 0, 0, m.w, m.h, 0, 0, m.w * SAMPLE_STEP, m.h * SAMPLE_STEP);
      return true;
    }
    if (!a.grid) return false;
    const layer = this.gridLayer(a.grid, zone, color);
    if (!layer) return false;
    const tl = screenToGeo(view, size.w, 0, 0);
    const br = screenToGeo(view, size.w, size.w, size.h);
    const c0 = Math.max(0, Math.floor((tl.lon + 180) / GRID_STEP) - 1);
    const c1 = Math.min(GRID_NX, Math.ceil((br.lon + 180) / GRID_STEP) + 1);
    const r0 = Math.max(0, Math.floor((90 - tl.lat) / GRID_STEP) - 1);
    const r1 = Math.min(GRID_NY, Math.ceil((90 - br.lat) / GRID_STEP) + 1);
    if (c1 <= c0 || r1 <= r0) return false;
    const origin = geoToScreen(view, size.w, 90 - r0 * GRID_STEP, -180 + c0 * GRID_STEP);
    const cell = GRID_STEP * UNITS_PER_DEG * baseScale(size.w) * view.k;
    ctx.drawImage(layer, c0, r0, c1 - c0, r1 - r0, origin.x, origin.y, (c1 - c0) * cell, (r1 - r0) * cell);
    return true;
  }

  paint(a: PaintArgs): void {
    const { canvas, size, dpr, view } = a;
    const pw = Math.round(size.w * dpr);
    const ph = Math.round(size.h * dpr);
    if (canvas.width !== pw) canvas.width = pw;
    if (canvas.height !== ph) canvas.height = ph;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, pw, ph);
    const active = a.masks.filter((m) => m.zone !== null);
    if (active.length === 0) return;

    this.scratch ??= newCanvas(pw, ph);
    if (this.scratch.width !== pw || this.scratch.height !== ph) {
      this.scratch.width = pw;
      this.scratch.height = ph;
    }
    const sctx = this.scratch.getContext('2d');
    if (!sctx) return;

    let stencil: HTMLCanvasElement | null = null;
    if (a.land) {
      this.stencil ??= newCanvas(pw, ph);
      if (this.stencil.width !== pw || this.stencil.height !== ph) {
        this.stencil.width = pw;
        this.stencil.height = ph;
      }
      const tctx = this.stencil.getContext('2d');
      if (tctx) {
        const s = baseScale(size.w) * view.k;
        tctx.setTransform(1, 0, 0, 1, 0, 0);
        tctx.clearRect(0, 0, pw, ph);
        tctx.setTransform(dpr * s, 0, 0, dpr * s, dpr * view.x, dpr * view.y);
        tctx.fillStyle = '#000';
        tctx.fill(a.land, 'evenodd');
        stencil = this.stencil;
      }
    }

    for (const m of active) {
      if (!m.zone) continue;
      sctx.setTransform(1, 0, 0, 1, 0, 0);
      sctx.globalCompositeOperation = 'source-over';
      sctx.clearRect(0, 0, pw, ph);
      sctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      if (!this.drawZone(sctx, a, m.zone, m.color)) continue;
      ctx.globalAlpha = m.seaAlpha;
      ctx.drawImage(this.scratch, 0, 0);
      if (stencil) {
        sctx.setTransform(1, 0, 0, 1, 0, 0);
        sctx.globalCompositeOperation = 'destination-in';
        sctx.drawImage(stencil, 0, 0);
        ctx.globalAlpha = m.landAlpha;
        ctx.drawImage(this.scratch, 0, 0);
      }
    }
    ctx.globalAlpha = 1;
  }
}
