// The page background is always the theme's opaque colour: nothing in the page lets the window show through it.
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { THEMES, applyTheme } from './themes';
import type { Theme } from './types';

const ALL = Object.keys(THEMES) as Theme[];

describe('the page background', () => {
  it('is the theme colour, opaque, in every theme and after every switch', () => {
    const root = document.createElement('div');
    for (const theme of [...ALL, ...[...ALL].reverse()]) {
      applyTheme(theme, root);
      expect(THEMES[theme].bg).toMatch(/^#[0-9a-f]{6}$/i);
      expect(root.style.getPropertyValue('--bg')).toBe(THEMES[theme].bg);
      expect(root.style.getPropertyValue('--bg-solid')).toBe(THEMES[theme].bg);
      expect({ ...root.dataset }).toEqual({ theme });
    }
  });

  it('is painted by the stylesheet before any script has run, and the stylesheet makes nothing transparent', () => {
    const base = readFileSync(path.resolve(import.meta.dirname, '../styles/base.css'), 'utf8');
    expect(base).toMatch(/:root \{ --bg: #[0-9a-f]{6}; --bg-solid: #[0-9a-f]{6}; \}/i);
    expect(base).toMatch(/\nhtml \{ background: var\(--bg\); \}/);
    expect(base).toMatch(/body \{[^}]*background: var\(--bg\)/);
    expect(base).not.toMatch(/background: transparent/);
  });
});
