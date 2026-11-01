// Mica is the one place the page background is translucent, so what stays readable and what stays opaque is
// checked here against the worst backdrops a wallpaper could put behind the window. Windows 11 only: nothing
// here proves how Mica looks, only that the tokens and CSS hold up when it is on.
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { contrast } from './color';
import { MICA_ALPHA, MICA_THEMES, THEMES, applyTheme, composite, glassBackground, showsMica } from './themes';
import type { Theme } from './types';

const base = readFileSync(path.resolve(import.meta.dirname, '../styles/base.css'), 'utf8');
const ALL: Theme[] = ['light', 'solarizedLight', 'solarizedDark', 'dark'];
// Pure white and black bracket every wallpaper in luminance; the saturated ones catch hue shifts.
const BACKDROPS = ['#000000', '#ffffff', '#ff0000', '#00ff00', '#0000ff', '#ffff00', '#ff00ff', '#00ffff', '#808080'];

const fresh = () => document.createElement('div');

describe('when Mica shows', () => {
  it('needs the switch on, a system that can, and the Light or Dark theme', () => {
    for (const theme of ALL) {
      for (const on of [true, false]) {
        for (const available of [true, false]) {
          expect(showsMica(theme, on, available), `${theme} on=${on} available=${available}`).toBe(on && available && (theme === 'light' || theme === 'dark'));
        }
      }
    }
    expect(MICA_THEMES).toEqual(['light', 'dark']);
  });
});

describe('applyTheme with Mica', () => {
  it('makes only the page background translucent, and marks the root, for Light and Dark', () => {
    for (const theme of MICA_THEMES) {
      const root = fresh();
      applyTheme(theme, root, true);
      expect(root.dataset.mica).toBe('on');
      expect(root.style.getPropertyValue('--bg')).toBe(glassBackground(THEMES[theme].bg));
      expect(root.style.getPropertyValue('--bg')).toMatch(/\/ 0\.\d+\)$/);
      // Panels, dialogs and every text colour keep their exact opaque token.
      for (const key of ['surface', 'surface-alt', 'text', 'text-muted', 'accent', 'border'] as const) {
        expect(root.style.getPropertyValue(`--${key}`)).toMatch(/^#[0-9a-f]{6}$/i);
      }
      expect(root.style.getPropertyValue('--surface')).toBe(THEMES[theme].surface);
    }
  });

  it('never changes Solarized: it stays opaque even when asked for Mica', () => {
    for (const theme of ['solarizedLight', 'solarizedDark'] as const) {
      const root = fresh();
      applyTheme(theme, root, true);
      expect(root.dataset.mica).toBeUndefined();
      expect(root.style.getPropertyValue('--bg')).toBe(THEMES[theme].bg);
    }
  });

  it('is fully opaque with Mica off, and switching it off again removes the marker', () => {
    for (const theme of ALL) {
      const root = fresh();
      applyTheme(theme, root, false);
      expect(root.dataset.mica).toBeUndefined();
      expect(root.style.getPropertyValue('--bg')).toBe(THEMES[theme].bg);
    }
    const root = fresh();
    applyTheme('light', root, true);
    applyTheme('light', root, false);
    expect(root.dataset.mica).toBeUndefined();
    expect(root.style.getPropertyValue('--bg')).toBe(THEMES.light.bg);
  });
});

describe('contrast over the worst backdrop', () => {
  const TEXT = ['text', 'textMuted', 'danger', 'warning', 'success', 'accent'] as const;
  for (const theme of MICA_THEMES) {
    it(`${theme}: text on the translucent page background stays at 4.5:1 or better over every backdrop`, () => {
      const t = THEMES[theme];
      const worst: string[] = [];
      for (const backdrop of BACKDROPS) {
        const shown = composite(t.bg, MICA_ALPHA, backdrop);
        for (const key of TEXT) {
          const ratio = contrast(t[key], shown);
          // Accent is used for large marks and the underline, so it needs 3:1 like other non-text; text colours 4.5:1.
          const need = key === 'accent' ? 3 : 4.5;
          if (ratio < need) worst.push(`${key} ${ratio.toFixed(2)} on ${shown} over ${backdrop}`);
        }
        expect(contrast(t.focus, shown), `focus over ${backdrop}`).toBeGreaterThanOrEqual(3);
      }
      expect(worst).toEqual([]);
    });
  }

  it('the opaque panels do not depend on the backdrop at all', () => {
    for (const theme of MICA_THEMES) {
      const t = THEMES[theme];
      expect(contrast(t.text, t.surface)).toBeGreaterThanOrEqual(7);
      expect(contrast(t.textMuted, t.surfaceAlt)).toBeGreaterThanOrEqual(4.5);
    }
  });
});

describe('CSS', () => {
  it('lets the window show only under data-mica, so the body is opaque (the --bg token) otherwise', () => {
    expect(base).toMatch(/body \{[^}]*background: var\(--bg\)/);
    expect(base).toMatch(/html\[data-mica='on'\][^{]*\{ background: transparent; \}/);
    // The only rule that makes the body transparent is under data-mica.
    expect((base.match(/background: transparent/g) ?? []).length).toBe(1);
  });
});
