// Design tokens per theme, applied as CSS variables. Light is the default; the OS theme is not
// followed. Solarized values are Ethan Schoonover's palette; themes.test.ts checks every pair.
import type { Theme } from './types';

export interface Tokens {
  bg: string;
  surface: string;
  surfaceAlt: string;
  border: string;
  borderStrong: string;
  text: string;
  textMuted: string;
  accent: string;
  onAccent: string;
  danger: string;
  warning: string;
  success: string;
  focus: string;
  axis: string;
  grid: string;
  shiftBand: string;
  /** Mark colours for concepts that belong to no single project. */
  cWorked: string;
  cPaused: string;
  cTarget: string;
  cPrevious: string;
  cOutside: string;
  mapLand: string;
  mapLine: string;
  mapHighlight: string;
  mapSelected: string;
  /** Vivid multi-hue sequential ramp, monotonic in lightness from low to high value. */
  heat: readonly [string, string, string, string, string, string];
}

const S = {
  base03: '#002b36', base02: '#073642', base01: '#586e75', base00: '#657b83',
  base0: '#839496', base1: '#93a1a1', base2: '#eee8d5', base3: '#fdf6e3',
  yellow: '#b58900', orange: '#cb4b16', red: '#dc322f', magenta: '#d33682',
  violet: '#6c71c4', blue: '#268bd2', cyan: '#2aa198', green: '#859900',
} as const;

export const THEMES: Record<Theme, Tokens> = {
  light: {
    bg: '#f3f4f6', surface: '#ffffff', surfaceAlt: '#e9ebef', border: '#d9dce3', borderStrong: '#6b7280',
    text: '#111827', textMuted: '#4b5563', accent: '#0f766e', onAccent: '#ffffff',
    danger: '#b91c1c', warning: '#92400e', success: '#166534', focus: '#1d4ed8',
    axis: '#4b5563', grid: '#d1d5db', shiftBand: '#dbeafe',
    cWorked: '#7c3aed', cPaused: '#ea580c', cTarget: '#db2777', cPrevious: '#0284c7', cOutside: '#4d7c0f',
    mapLand: '#e5e7eb', mapLine: '#9ca3af', mapHighlight: '#f59e0b', mapSelected: '#0f766e',
    heat: ['#fde68a', '#fbbf24', '#f97316', '#db2777', '#7e22ce', '#3b0764'],
  },
  solarizedLight: {
    bg: S.base3, surface: S.base3, surfaceAlt: S.base2, border: '#d9d2bd', borderStrong: S.base00,
    text: S.base02, textMuted: S.base01, accent: S.base01, onAccent: S.base3,
    danger: '#b0261f', warning: '#8a6800', success: '#5f6e00', focus: S.blue,
    axis: S.base01, grid: '#d9d2bd', shiftBand: S.base2,
    cWorked: S.violet, cPaused: S.orange, cTarget: S.magenta, cPrevious: S.blue, cOutside: '#6f8000',
    mapLand: S.base2, mapLine: S.base1, mapHighlight: S.yellow, mapSelected: S.base01,
    heat: [S.base2, '#e0c060', S.yellow, S.orange, '#9b2d6e', '#3d3a8a'],
  },
  solarizedDark: {
    bg: S.base03, surface: S.base03, surfaceAlt: S.base02, border: '#14505e', borderStrong: S.base0,
    text: S.base2, textMuted: S.base0, accent: S.cyan, onAccent: S.base03,
    danger: '#f0655f', warning: S.yellow, success: S.green, focus: S.blue,
    axis: S.base0, grid: '#14505e', shiftBand: S.base02,
    cWorked: '#8f94e8', cPaused: '#e8703a', cTarget: '#e65a9e', cPrevious: S.blue, cOutside: S.green,
    mapLand: S.base02, mapLine: S.base01, mapHighlight: S.yellow, mapSelected: S.cyan,
    heat: [S.base02, '#3d3a8a', '#9b2d6e', S.orange, S.yellow, S.base3],
  },
  dark: {
    bg: '#17181b', surface: '#212226', surfaceAlt: '#2b2d32', border: '#3a3c43', borderStrong: '#9ca3af',
    text: '#f3f4f6', textMuted: '#b0b5bf', accent: '#2dd4bf', onAccent: '#06201d',
    danger: '#f87171', warning: '#fbbf24', success: '#4ade80', focus: '#60a5fa',
    axis: '#b0b5bf', grid: '#3a3c43', shiftBand: '#2b3a55',
    cWorked: '#a78bfa', cPaused: '#fb923c', cTarget: '#f472b6', cPrevious: '#38bdf8', cOutside: '#a3e635',
    mapLand: '#2b2d32', mapLine: '#5b5f68', mapHighlight: '#fbbf24', mapSelected: '#2dd4bf',
    heat: ['#312e81', '#7e22ce', '#db2777', '#f97316', '#fbbf24', '#fef9c3'],
  },
};

export const THEME_LABELS: Record<Theme, string> = {
  light: 'Light',
  solarizedLight: 'Solarized Light',
  solarizedDark: 'Solarized Dark',
  dark: 'Dark',
};

const kebab = (s: string): string => s.replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`);

/** Sets the CSS variables on the root element, such as `--text` and `--c-worked` and `--heat-0`. */
export function applyTheme(theme: Theme, root: HTMLElement = document.documentElement): void {
  const tokens = THEMES[theme];
  for (const [key, value] of Object.entries(tokens)) {
    if (typeof value === 'string') root.style.setProperty(`--${kebab(key)}`, value);
    else (value as readonly string[]).forEach((c, i) => root.style.setProperty(`--${kebab(key)}-${i}`, c));
  }
  root.dataset.theme = theme;
  root.style.colorScheme = theme === 'dark' || theme === 'solarizedDark' ? 'dark' : 'light';
}
