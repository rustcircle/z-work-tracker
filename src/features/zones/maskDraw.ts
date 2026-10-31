// Paints the zone highlights onto the map's canvas. Over land the colour is strong; over open water the
// zone is only tinted. The mask is always sampled at screen resolution (never from the 0.5 degree grid),
// so edges follow the real zone borders at every zoom instead of showing coarse squares.
import { sampleZoneMask } from './sample';
import { baseScale, type View } from './viewport';

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
  land: Path2D | null;
  masks: readonly MaskSpec[];
}

/** Sample spacing in CSS pixels: fine when zoomed in, a little coarser at world view to bound the per-frame cost. */
/** Below this much land (CSS px squared) in view, the zone also gets its sea tint so it stays visible. */
const MIN_LAND_AREA = 60;

const sampleStep = (k: number): number => (k >= 2 ? 2 : 3);

function newCanvas(w: number, h: number): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
}

export class MaskPainter {
  private stencil: HTMLCanvasElement | null = null;
  private scratch: HTMLCanvasElement | null = null;
  private clipped: HTMLCanvasElement | null = null;
  private probe: HTMLCanvasElement | null = null;
  private sampled: HTMLCanvasElement | null = null;

  /** Approximate painted area of `layer` in CSS pixels, measured on a copy shrunk four times. */
  private landArea(layer: HTMLCanvasElement, dpr: number): number {
    const w = Math.max(1, Math.ceil(layer.width / 4));
    const h = Math.max(1, Math.ceil(layer.height / 4));
    this.probe ??= newCanvas(w, h);
    if (this.probe.width !== w) this.probe.width = w;
    if (this.probe.height !== h) this.probe.height = h;
    const pctx = this.probe.getContext('2d', { willReadFrequently: true });
    if (!pctx) return Infinity;
    pctx.setTransform(1, 0, 0, 1, 0, 0);
    pctx.clearRect(0, 0, w, h);
    pctx.drawImage(layer, 0, 0, w, h);
    const px = pctx.getImageData(0, 0, w, h).data;
    let alpha = 0;
    for (let i = 3; i < px.length; i += 4) alpha += px[i] as number;
    return (alpha / 255) * (16 / (dpr * dpr));
  }

  /** Draws the zone into `scratch` (CSS-pixel coordinates). Returns false when nothing could be drawn. */
  private drawZone(ctx: CanvasRenderingContext2D, a: PaintArgs, zone: string, color: string): boolean {
    const { size, view } = a;
    const step = sampleStep(view.k);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    const m = sampleZoneMask(zone, view, size, step);
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
    ctx.drawImage(this.sampled, 0, 0, m.w, m.h, 0, 0, m.w * step, m.h * step);
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
      if (!stencil) {
        ctx.globalAlpha = m.seaAlpha;
        ctx.drawImage(this.scratch, 0, 0);
        continue;
      }
      // The zone data is coarse over open water, so the highlight is clipped to the country outlines.
      // Only a zone with (almost) no land in view, such as a small island group, keeps a faint sea tint.
      this.clipped ??= newCanvas(pw, ph);
      if (this.clipped.width !== pw || this.clipped.height !== ph) {
        this.clipped.width = pw;
        this.clipped.height = ph;
      }
      const cctx = this.clipped.getContext('2d');
      if (!cctx) continue;
      cctx.setTransform(1, 0, 0, 1, 0, 0);
      cctx.globalCompositeOperation = 'source-over';
      cctx.clearRect(0, 0, pw, ph);
      cctx.drawImage(this.scratch, 0, 0);
      cctx.globalCompositeOperation = 'destination-in';
      cctx.drawImage(stencil, 0, 0);
      if (this.landArea(this.clipped, dpr) < MIN_LAND_AREA) {
        ctx.globalAlpha = m.seaAlpha;
        ctx.drawImage(this.scratch, 0, 0);
      }
      ctx.globalAlpha = m.landAlpha;
      ctx.drawImage(this.clipped, 0, 0);
    }
    ctx.globalAlpha = 1;
  }
}
