// Pan and zoom maths for the map, kept pure so it is testable without a DOM.
import { fromWorld, toWorld, WORLD_H, WORLD_W } from './geo';

export interface View {
  /** Zoom factor; 1 shows the whole world across the full width. */
  k: number;
  /** Screen position of the world's top-left corner, in CSS pixels. */
  x: number;
  y: number;
}

export const MIN_K = 1;
/** Past this the zone boundary data (quad-tree tiles, accurate to a few km at best) shows its blocks. */
export const MAX_K = 24;

/** CSS pixels per world unit at zoom 1. */
export const baseScale = (width: number): number => width / WORLD_W;

export function clampView(v: View, width: number, height: number): View {
  const k = Math.min(MAX_K, Math.max(MIN_K, v.k));
  const s = baseScale(width) * k;
  const w = WORLD_W * s;
  const h = WORLD_H * s;
  const x = w <= width ? (width - w) / 2 : Math.min(0, Math.max(width - w, v.x));
  const y = h <= height ? (height - h) / 2 : Math.min(0, Math.max(height - h, v.y));
  return { k, x, y };
}

export const fitView = (width: number, height: number): View => clampView({ k: 1, x: 0, y: 0 }, width, height);

export function zoomAbout(v: View, factor: number, px: number, py: number, width: number, height: number): View {
  const k = Math.min(MAX_K, Math.max(MIN_K, v.k * factor));
  const ratio = k / v.k;
  return clampView({ k, x: px - (px - v.x) * ratio, y: py - (py - v.y) * ratio }, width, height);
}

export const panBy = (v: View, dx: number, dy: number, width: number, height: number): View =>
  clampView({ ...v, x: v.x + dx, y: v.y + dy }, width, height);

export function screenToGeo(v: View, width: number, px: number, py: number): { lat: number; lon: number } {
  const s = baseScale(width) * v.k;
  return fromWorld((px - v.x) / s, (py - v.y) / s);
}

export function geoToScreen(v: View, width: number, lat: number, lon: number): { x: number; y: number } {
  const s = baseScale(width) * v.k;
  const w = toWorld(lat, lon);
  return { x: v.x + w.x * s, y: v.y + w.y * s };
}
