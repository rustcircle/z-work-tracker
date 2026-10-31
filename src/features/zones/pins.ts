// City pins and their labels. Labels are placed greedily (My zone and Client zone first) and dropped
// when they would collide with another label, the map controls or the edge, so the map stays legible.
import { geoToScreen, type View } from './viewport';

export type PinKind = 'city' | 'mine' | 'client';

export interface Pin {
  key: string;
  kind: PinKind;
  zone: string;
  label: string;
  lat: number;
  lon: number;
}

export interface PlacedPin extends Pin {
  x: number;
  y: number;
  /** Where the label goes; null when it would collide with another label. */
  labelAt: { x: number; anchor: 'start' | 'end' } | null;
}

export interface Size {
  w: number;
  h: number;
}

export function placePins(pins: readonly Pin[], view: View, size: Size): PlacedPin[] {
  type Rect = { x0: number; y0: number; x1: number; y1: number };
  const hit = (a: Rect, b: Rect): boolean => a.x0 < b.x1 && a.x1 > b.x0 && a.y0 < b.y1 && a.y1 > b.y0;
  // The zoom buttons and the info card sit over the map; nothing is placed beneath them.
  const markers: Rect[] = [
    { x0: size.w - 50, y0: size.h - 124, x1: size.w, y1: size.h },
    { x0: 0, y0: size.h - 42, x1: size.w, y1: size.h },
  ];
  const placed: PlacedPin[] = [];
  // First pass: markers, in priority order. A marker is dropped only if it sits on another marker.
  for (const pin of pins) {
    const { x, y } = geoToScreen(view, size.w, pin.lat, pin.lon);
    if (x < 8 || y < 8 || x > size.w - 8 || y > size.h - 8) continue;
    const r = pin.kind === 'city' ? 4.5 : 8;
    const box = { x0: x - r, y0: y - r, x1: x + r, y1: y + r };
    if (markers.some((m) => hit(m, box))) continue;
    markers.push(box);
    placed.push({ ...pin, x, y, labelAt: null });
  }
  // Second pass: labels, again in priority order, to the right or else the left of their marker.
  const labels: Rect[] = [];
  for (const p of placed) {
    const textW = p.label.length * 6.3 + 8;
    const right = { x0: p.x + 9, y0: p.y - 8, x1: p.x + 9 + textW, y1: p.y + 8 };
    const left = { x0: p.x - 9 - textW, y0: p.y - 8, x1: p.x - 9, y1: p.y + 8 };
    const free = (r: Rect): boolean => r.x0 >= 2 && r.x1 <= size.w - 2 && !markers.some((m) => hit(m, r)) && !labels.some((l) => hit(l, r));
    if (free(right)) {
      p.labelAt = { x: p.x + 10, anchor: 'start' };
      labels.push(right);
    } else if (free(left)) {
      p.labelAt = { x: p.x - 10, anchor: 'end' };
      labels.push(left);
    }
  }
  return placed;
}
