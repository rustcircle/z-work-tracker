// WCAG contrast, readable text on project colours, and the curated project palette.

export function parseHex(hex: string): [number, number, number] {
  const n = Number.parseInt(hex.replace('#', ''), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

export function luminance(hex: string): number {
  const [r, g, b] = parseHex(hex).map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function contrast(a: string, b: string): number {
  const la = luminance(a);
  const lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/** Black or white, whichever reads better. One of them always reaches WCAG AA 4.5:1. */
export const readableText = (bg: string): '#000000' | '#ffffff' => (contrast(bg, '#000000') >= contrast(bg, '#ffffff') ? '#000000' : '#ffffff');

export const PROJECT_PALETTE = [
  '#2563eb', '#dc2626', '#059669', '#d97706', '#7c3aed', '#db2777',
  '#0891b2', '#65a30d', '#ea580c', '#4f46e5', '#0d9488', '#be123c',
] as const;

/**
 * Page and card backgrounds of the four themes. The backend's `colors.rs` holds the same values
 * (colors.test.ts pins both to themes.ts), so a colour is judged readable by the same rule on each side.
 */
export const THEME_BACKGROUNDS: readonly string[] = ['#f3f4f6', '#ffffff', '#fdf6e3', '#002b36', '#17181b', '#212226', '#073642'];
/** Below this contrast a colour is hard to see against a background. */
const MIN_CONTRAST = 2;
/** OKLab distance that reads as a different colour. */
const DISTINCT = 0.09;
const TRIES = 400;

const toLinear = (c: number): number => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const toGamma = (c: number): number => (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055);

function oklab(hex: string): [number, number, number] | null {
  const norm = normalizeHexStrict(hex);
  if (!norm) return null;
  const n = Number.parseInt(norm.slice(1), 16);
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => toLinear(v / 255)) as [number, number, number];
  const l = Math.cbrt(0.41222147 * r + 0.53633254 * g + 0.05144599 * b);
  const m = Math.cbrt(0.2119035 * r + 0.68069955 * g + 0.10739696 * b);
  const s = Math.cbrt(0.08830246 * r + 0.28171884 * g + 0.62997870 * b);
  return [0.21045426 * l + 0.79361779 * m - 0.00407205 * s, 1.9779985 * l - 2.42859221 * m + 0.45059371 * s, 0.02590404 * l + 0.78277177 * m - 0.80867577 * s];
}

/** Exactly `#rrggbb` (any case) or null: the shape the backend stores. */
function normalizeHexStrict(hex: string): string | null {
  return /^#[0-9a-fA-F]{6}$/.test(hex) ? hex.toLowerCase() : null;
}

/** The sRGB colour of these OKLCH values, or null when they fall outside sRGB. Ported from `colors.rs`. */
export function fromOklch(l: number, c: number, hueDegrees: number): string | null {
  const rad = (hueDegrees * Math.PI) / 180;
  const a = c * Math.cos(rad);
  const b = c * Math.sin(rad);
  const lp = (l + 0.39633778 * a + 0.21580376 * b) ** 3;
  const mp = (l - 0.10556135 * a - 0.06385417 * b) ** 3;
  const sp = (l - 0.08948418 * a - 1.29148555 * b) ** 3;
  const rgb = [4.07674166 * lp - 3.30771159 * mp + 0.23096993 * sp, -1.26843800 * lp + 2.60975740 * mp - 0.34131940 * sp, -0.00419609 * lp - 0.70341861 * mp + 1.70761470 * sp];
  if (rgb.some((v) => !(v >= -0.0001 && v <= 1.0001))) return null;
  return `#${rgb.map((v) => Math.round(toGamma(Math.min(1, Math.max(0, v))) * 255).toString(16).padStart(2, '0')).join('')}`;
}

/** Distance between two colours in OKLab. A colour that can't be read counts as far away. */
export function distance(a: string, b: string): number {
  const x = oklab(a);
  const y = oklab(b);
  if (!x || !y) return Number.MAX_VALUE;
  return Math.hypot(x[0] - y[0], x[1] - y[1], x[2] - y[2]);
}

const readableEverywhere = (hex: string): boolean => THEME_BACKGROUNDS.every((bg) => contrast(hex, bg) >= MIN_CONTRAST);

/**
 * A random colour, readable on all four themes, as far as it can be from every colour in `taken`; never
 * exactly one of them. `random` returns a number in [0, 1) and is injected so tests can fix it.
 */
export function distinctColor(taken: readonly string[], random: () => number = Math.random): string {
  let best: { nearest: number; hex: string } | null = null;
  for (let i = 0; i < TRIES; i += 1) {
    const l = 0.52 + 0.14 * random();
    const c = 0.09 + 0.09 * random();
    const h = 360 * random();
    const hex = fromOklch(l, c, h);
    if (!hex || !readableEverywhere(hex)) continue;
    if (taken.some((t) => t.toLowerCase() === hex)) continue;
    const nearest = taken.reduce((m, t) => Math.min(m, distance(t, hex)), Number.MAX_VALUE);
    if (nearest >= DISTINCT) return hex;
    if (!best || nearest > best.nearest) best = { nearest, hex };
  }
  return best?.hex ?? '#7c5cbf';
}

/**
 * The first curated colour nobody uses. Once the palette runs out the generator takes over, so a
 * suggestion never repeats a colour in use.
 */
export function suggestColor(used: readonly string[], random: () => number = Math.random): string {
  const lower = new Set(used.map((c) => c.toLowerCase()));
  return PROJECT_PALETTE.find((c) => !lower.has(c)) ?? distinctColor(used, random);
}

// ---- The colour picker's pure logic: conversions, parsing, distance and keyboard steps. ----

export interface Rgb {
  r: number;
  g: number;
  b: number;
}

/** Hue in degrees (0 to 360), saturation and value (brightness) as fractions (0 to 1). */
export interface Hsv {
  h: number;
  s: number;
  v: number;
}

const clamp = (n: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, n));
const hex2 = (n: number): string => clamp(Math.round(n), 0, 255).toString(16).padStart(2, '0');

/** `#rrggbb`, lowercase, from channels that are rounded and held to 0 to 255. */
export const rgbToHex = ({ r, g, b }: Rgb): string => `#${hex2(r)}${hex2(g)}${hex2(b)}`;

/**
 * Reads `#rgb`, `rgb`, `#rrggbb` or `rrggbb` (any case, surrounding space ignored) and returns the
 * canonical `#rrggbb` the backend accepts, or null for anything else.
 */
export function normalizeHex(input: string): string | null {
  const t = input.trim().replace(/^#/, '');
  if (/^[0-9a-fA-F]{3}$/.test(t)) return `#${[...t].map((c) => c + c).join('').toLowerCase()}`;
  if (/^[0-9a-fA-F]{6}$/.test(t)) return `#${t.toLowerCase()}`;
  return null;
}

export function hexToRgb(input: string): Rgb | null {
  const hex = normalizeHex(input);
  if (!hex) return null;
  return { r: Number.parseInt(hex.slice(1, 3), 16), g: Number.parseInt(hex.slice(3, 5), 16), b: Number.parseInt(hex.slice(5, 7), 16) };
}

/** A whole number from 0 to 255 typed into an R, G or B field, else null. */
export function parseChannel(text: string): number | null {
  const t = text.trim();
  if (!/^\d{1,3}$/.test(t)) return null;
  const n = Number(t);
  return n <= 255 ? n : null;
}

export function rgbToHsv({ r, g, b }: Rgb): Hsv {
  const R = r / 255;
  const G = g / 255;
  const B = b / 255;
  const max = Math.max(R, G, B);
  const delta = max - Math.min(R, G, B);
  let h = 0;
  if (delta > 0) {
    if (max === R) h = ((G - B) / delta) % 6;
    else if (max === G) h = (B - R) / delta + 2;
    else h = (R - G) / delta + 4;
    h *= 60;
    if (h < 0) h += 360;
  }
  return { h, s: max === 0 ? 0 : delta / max, v: max };
}

export function hsvToRgb({ h, s, v }: Hsv): Rgb {
  const hh = (((h % 360) + 360) % 360) / 60;
  const c = v * s;
  const x = c * (1 - Math.abs((hh % 2) - 1));
  const m = v - c;
  const [r, g, b] = hh < 1 ? [c, x, 0] : hh < 2 ? [x, c, 0] : hh < 3 ? [0, c, x] : hh < 4 ? [0, x, c] : hh < 5 ? [x, 0, c] : [c, 0, x];
  return { r: Math.round((r + m) * 255), g: Math.round((g + m) * 255), b: Math.round((b + m) * 255) };
}

export const hsvToHex = (hsv: Hsv): string => rgbToHex(hsvToRgb(hsv));

/** The colour as HSV. A grey has no hue of its own, so `keepHue` (the hue the picker was showing) is used. */
export function hexToHsv(input: string, keepHue = 0): Hsv {
  const rgb = hexToRgb(input) ?? { r: 0, g: 0, b: 0 };
  const hsv = rgbToHsv(rgb);
  const hueless = hsv.s === 0 || hsv.v === 0;
  return { h: hueless ? keepHue : hsv.h, s: hsv.s, v: hsv.v };
}

/** HSL, for showing a colour the way designers often name it. */
export function rgbToHsl({ r, g, b }: Rgb): { h: number; s: number; l: number } {
  const { h, s: sv, v } = rgbToHsv({ r, g, b });
  const l = v * (1 - sv / 2);
  return { h, s: l === 0 || l === 1 ? 0 : (v - l) / Math.min(l, 1 - l), l };
}

function srgbToLab({ r, g, b }: Rgb): [number, number, number] {
  const lin = (v: number): number => {
    const c = v / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  const [R, G, B] = [lin(r), lin(g), lin(b)];
  const X = (0.4124564 * R + 0.3575761 * G + 0.1804375 * B) / 0.95047;
  const Y = 0.2126729 * R + 0.7151522 * G + 0.072175 * B;
  const Z = (0.0193339 * R + 0.119192 * G + 0.9503041 * B) / 1.08883;
  const f = (t: number): number => (t > 216 / 24389 ? Math.cbrt(t) : (24389 / 27 * t + 16) / 116);
  const [fx, fy, fz] = [f(X), f(Y), f(Z)];
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}

/** CIE76 colour difference: 0 for the same colour, about 2 is just noticeable, 100 between black and white. */
export function colorDistance(a: string, b: string): number {
  const ra = hexToRgb(a);
  const rb = hexToRgb(b);
  if (!ra || !rb) return Number.POSITIVE_INFINITY;
  const [l1, a1, b1] = srgbToLab(ra);
  const [l2, a2, b2] = srgbToLab(rb);
  return Math.hypot(l1 - l2, a1 - a2, b1 - b2);
}

/** Below this distance two colours are hard to tell apart in a chart. */
export const SIMILAR_COLOR_DISTANCE = 12;
/** Below this contrast ratio a filled shape is hard to see on the page (WCAG asks 3 for graphics; text on chips is handled apart). */
export const MIN_VISIBLE_CONTRAST = 2;

export interface Neighbour {
  name: string;
  color: string;
}

/** The nearest of `others` when it is close enough to confuse with `color`, else null. */
export function similarColor(color: string, others: readonly Neighbour[]): { name: string; color: string; distance: number } | null {
  let best: { name: string; color: string; distance: number } | null = null;
  for (const o of others) {
    const distance = colorDistance(color, o.color);
    if (distance < SIMILAR_COLOR_DISTANCE && (best === null || distance < best.distance)) best = { name: o.name, color: o.color, distance };
  }
  return best;
}

/** The weakest contrast of `color` against the given backgrounds, as a ratio such as 2.4. */
export const weakestContrast = (color: string, backgrounds: readonly string[]): number => Math.min(...backgrounds.map((bg) => contrast(color, bg)));

// ---- Keyboard control of the saturation/brightness area and the hue slider. ----

export type StepKey = 'ArrowLeft' | 'ArrowRight' | 'ArrowUp' | 'ArrowDown' | 'Home' | 'End' | 'PageUp' | 'PageDown';
const STEP_KEYS: readonly string[] = ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'PageUp', 'PageDown'];
export const isStepKey = (key: string): key is StepKey => STEP_KEYS.includes(key);

/**
 * The area has saturation on its horizontal axis and brightness on its vertical one. Arrows move by
 * 1 percentage point (10 with Shift); Home and End jump to no and full saturation; PageUp and
 * PageDown move brightness by 10 points (25 with Shift). Returns null for a key that does nothing.
 */
export function stepArea(hsv: Hsv, key: string, shift: boolean): Hsv | null {
  if (!isStepKey(key)) return null;
  const small = shift ? 0.1 : 0.01;
  const page = shift ? 0.25 : 0.1;
  let { s, v } = hsv;
  switch (key) {
    case 'ArrowRight': s += small; break;
    case 'ArrowLeft': s -= small; break;
    case 'ArrowUp': v += small; break;
    case 'ArrowDown': v -= small; break;
    case 'Home': s = 0; break;
    case 'End': s = 1; break;
    case 'PageUp': v += page; break;
    case 'PageDown': v -= page; break;
  }
  return { h: hsv.h, s: round4(clamp(s, 0, 1)), v: round4(clamp(v, 0, 1)) };
}

/**
 * Hue runs 0 to 360 degrees. Arrows move by 1 degree (15 with Shift), PageUp and PageDown by 30,
 * Home and End go to 0 and 360. Up and Right increase, as for any slider.
 */
export function stepHue(h: number, key: string, shift: boolean): number | null {
  if (!isStepKey(key)) return null;
  const small = shift ? 15 : 1;
  switch (key) {
    case 'ArrowRight':
    case 'ArrowUp': return clamp(h + small, 0, 360);
    case 'ArrowLeft':
    case 'ArrowDown': return clamp(h - small, 0, 360);
    case 'PageUp': return clamp(h + 30, 0, 360);
    case 'PageDown': return clamp(h - 30, 0, 360);
    case 'Home': return 0;
    case 'End': return 360;
  }
}

const round4 = (n: number): number => Math.round(n * 10_000) / 10_000;

/** A point in the area (fractions of its width and height from the top left) as saturation and brightness. */
export const areaPoint = (hsv: Hsv, x: number, y: number): Hsv => ({ h: hsv.h, s: clamp(x, 0, 1), v: clamp(1 - y, 0, 1) });
export const huePoint = (x: number): number => clamp(x, 0, 1) * 360;
