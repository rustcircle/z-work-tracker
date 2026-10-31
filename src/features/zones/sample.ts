// Viewport-resolution zone mask: the 0.5 degree grid is too coarse for a clean edge at any zoom, so the
// visible area is sampled directly (about 10 ms per frame at world view, measured on 80k lookups).
import { lookupZone } from './geo';
import { screenToGeo, type View } from './viewport';

export interface SampledMask {
  w: number;
  h: number;
  /** RGBA, alpha 255 where the sample lies in the zone. */
  data: Uint8ClampedArray<ArrayBuffer>;
}

export function sampleZoneMask(zone: string, view: View, size: { w: number; h: number }, step: number): SampledMask {
  const w = Math.max(1, Math.ceil(size.w / step));
  const h = Math.max(1, Math.ceil(size.h / step));
  const data = new Uint8ClampedArray(w * h * 4);
  for (let j = 0; j < h; j += 1) {
    for (let i = 0; i < w; i += 1) {
      const { lat, lon } = screenToGeo(view, size.w, (i + 0.5) * step, (j + 0.5) * step);
      if (lat > 90 || lat < -90 || lon < -180 || lon > 180) continue;
      if (lookupZone(lat, lon) === zone) data[(j * w + i) * 4 + 3] = 255;
    }
  }
  return { w, h, data };
}
