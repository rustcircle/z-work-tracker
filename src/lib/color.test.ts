import { describe, expect, it } from 'vitest';

import {
  MIN_VISIBLE_CONTRAST,
  PROJECT_PALETTE,
  SIMILAR_COLOR_DISTANCE,
  areaPoint,
  colorDistance,
  contrast,
  hexToHsv,
  hexToRgb,
  hsvToHex,
  hsvToRgb,
  huePoint,
  isStepKey,
  normalizeHex,
  parseChannel,
  readableText,
  rgbToHex,
  rgbToHsl,
  rgbToHsv,
  similarColor,
  stepArea,
  stepHue,
  weakestContrast,
} from './color';
import { THEMES } from './themes';

describe('hex and RGB', () => {
  it('converts both ways and always writes six lowercase digits', () => {
    expect(rgbToHex({ r: 255, g: 0, b: 128 })).toBe('#ff0080');
    expect(rgbToHex({ r: 0, g: 0, b: 0 })).toBe('#000000');
    expect(hexToRgb('#1A2B3C')).toEqual({ r: 26, g: 43, b: 60 });
  });

  it('holds out-of-range channels to 0..255 and rounds fractions', () => {
    expect(rgbToHex({ r: -4, g: 300, b: 127.6 })).toBe('#00ff80');
  });

  it.each([
    ['#1a2b3c', '#1a2b3c'],
    ['1A2B3C', '#1a2b3c'],
    ['  #AbCdEf  ', '#abcdef'],
    ['#abc', '#aabbcc'],
    ['FA0', '#ffaa00'],
  ])('normalises %j to %j', (input, want) => {
    expect(normalizeHex(input)).toBe(want);
  });

  it.each(['', '#', '#12', '#12345', '#1234567', '#12345g', 'red', 'rgb(1,2,3)', '##123456', '#12 3456', '#12345é', '0x123456', '#1a2b3c4d'])('refuses %j', (bad) => {
    expect(normalizeHex(bad)).toBeNull();
    expect(hexToRgb(bad)).toBeNull();
  });

  it('reads R, G and B fields as whole numbers from 0 to 255 only', () => {
    expect(parseChannel('0')).toBe(0);
    expect(parseChannel(' 255 ')).toBe(255);
    expect(parseChannel('007')).toBe(7);
    for (const bad of ['', '256', '-1', '1.5', 'a', '1e2', '1000', '+5']) expect(parseChannel(bad)).toBeNull();
  });
});

describe('round trips', () => {
  it('RGB to HSV to RGB is exact on a grid of 140 thousand colours', () => {
    const steps = [...Array.from({ length: 52 }, (_, i) => i * 5), 255];
    let n = 0;
    for (const r of steps) for (const g of steps) for (const b of steps) {
      n += 1;
      const back = hsvToRgb(rgbToHsv({ r, g, b }));
      if (back.r !== r || back.g !== g || back.b !== b) expect(back).toEqual({ r, g, b });
    }
    expect(n).toBe(53 ** 3);
  });

  it('hex to HSV to hex is exact for random colours, so the picker can never loop on its own value', () => {
    let seed = 12345;
    const next = (): number => {
      seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
      return seed;
    };
    for (let i = 0; i < 60_000; i += 1) {
      const hex = `#${(next() % 0x1000000).toString(16).padStart(6, '0')}`;
      expect(hsvToHex(hexToHsv(hex))).toBe(hex);
    }
  });

  it('every curated palette colour survives the round trip', () => {
    for (const c of PROJECT_PALETTE) expect(hsvToHex(hexToHsv(c))).toBe(c);
  });

  it('knows the primaries, white, black and greys', () => {
    expect(rgbToHsv({ r: 255, g: 0, b: 0 })).toEqual({ h: 0, s: 1, v: 1 });
    expect(rgbToHsv({ r: 0, g: 255, b: 0 }).h).toBe(120);
    expect(rgbToHsv({ r: 0, g: 0, b: 255 }).h).toBe(240);
    expect(rgbToHsv({ r: 255, g: 255, b: 255 })).toEqual({ h: 0, s: 0, v: 1 });
    expect(rgbToHsv({ r: 0, g: 0, b: 0 })).toEqual({ h: 0, s: 0, v: 0 });
    expect(hsvToHex({ h: 360, s: 1, v: 1 })).toBe('#ff0000');
    expect(hsvToHex({ h: -120, s: 1, v: 1 })).toBe('#0000ff');
  });

  it('a grey has no hue of its own, so the hue the picker showed is kept', () => {
    expect(hexToHsv('#808080', 200).h).toBe(200);
    expect(hexToHsv('#000000', 77).h).toBe(77);
    expect(hexToHsv('#ff0000', 200).h).toBe(0);
    expect(hexToHsv('not a colour').v).toBe(0);
  });

  it('HSL matches the usual values', () => {
    expect(rgbToHsl({ r: 255, g: 0, b: 0 })).toEqual({ h: 0, s: 1, l: 0.5 });
    expect(rgbToHsl({ r: 255, g: 255, b: 255 })).toEqual({ h: 0, s: 0, l: 1 });
    const mid = rgbToHsl({ r: 64, g: 128, b: 191 });
    expect(mid.h).toBeCloseTo(210, 0);
    expect(mid.s).toBeCloseTo(0.498, 2);
    expect(mid.l).toBeCloseTo(0.5, 1);
  });
});

describe('distance, similarity and contrast', () => {
  it('measures how far apart two colours look', () => {
    expect(colorDistance('#2563eb', '#2563eb')).toBe(0);
    expect(colorDistance('#000000', '#ffffff')).toBeCloseTo(100, 0);
    expect(colorDistance('#2563eb', '#2564ec')).toBeLessThan(2);
    expect(colorDistance('#2563eb', '#dc2626')).toBeGreaterThan(40);
    expect(colorDistance('#2563eb', 'nope')).toBe(Number.POSITIVE_INFINITY);
  });

  it('the curated palette is made of colours that are all far apart', () => {
    for (const a of PROJECT_PALETTE) for (const b of PROJECT_PALETTE) if (a !== b) expect(colorDistance(a, b)).toBeGreaterThan(SIMILAR_COLOR_DISTANCE);
  });

  it('finds the nearest similar colour and ignores far ones', () => {
    const others = [
      { name: 'Website', color: '#dc2626' },
      { name: 'Brand', color: '#2563eb' },
    ];
    expect(similarColor('#2563eb', others)).toMatchObject({ name: 'Brand', distance: 0 });
    expect(similarColor('#2666ee', others)?.name).toBe('Brand');
    expect(similarColor('#059669', others)).toBeNull();
    expect(similarColor('#059669', [])).toBeNull();
  });

  it('no curated colour trips the low-contrast warning in any theme, but pale and near-black colours do', () => {
    for (const t of Object.values(THEMES)) {
      for (const c of PROJECT_PALETTE) expect(weakestContrast(c, [t.bg, t.surface]), `${c} on ${t.bg}`).toBeGreaterThanOrEqual(MIN_VISIBLE_CONTRAST);
    }
    expect(weakestContrast('#fde047', [THEMES.light.bg, THEMES.light.surface])).toBeLessThan(MIN_VISIBLE_CONTRAST);
    expect(weakestContrast('#1e1f22', [THEMES.dark.bg, THEMES.dark.surface])).toBeLessThan(MIN_VISIBLE_CONTRAST);
  });

  it('chip text is the better of black and white, for any colour, and reaches 4.5 to 1', () => {
    for (const c of ['#000000', '#ffffff', '#808080', '#fde047', '#1e1f22', '#7f7f7f', '#767676', '#777777']) {
      expect(contrast(c, readableText(c))).toBeGreaterThanOrEqual(4.5);
    }
  });
});

describe('keyboard steps', () => {
  const base = { h: 200, s: 0.5, v: 0.5 };

  it('arrows move saturation and brightness by one point, Shift by ten', () => {
    expect(stepArea(base, 'ArrowRight', false)).toEqual({ h: 200, s: 0.51, v: 0.5 });
    expect(stepArea(base, 'ArrowLeft', false)).toEqual({ h: 200, s: 0.49, v: 0.5 });
    expect(stepArea(base, 'ArrowUp', false)).toEqual({ h: 200, s: 0.5, v: 0.51 });
    expect(stepArea(base, 'ArrowDown', true)).toEqual({ h: 200, s: 0.5, v: 0.4 });
    expect(stepArea(base, 'ArrowRight', true)).toEqual({ h: 200, s: 0.6, v: 0.5 });
  });

  it('Home, End, Page Up and Page Down jump', () => {
    expect(stepArea(base, 'Home', false)?.s).toBe(0);
    expect(stepArea(base, 'End', false)?.s).toBe(1);
    expect(stepArea(base, 'PageUp', false)?.v).toBe(0.6);
    expect(stepArea(base, 'PageDown', false)?.v).toBe(0.4);
    expect(stepArea(base, 'PageUp', true)?.v).toBe(0.75);
  });

  it('never leaves 0 to 1 and ignores other keys', () => {
    expect(stepArea({ h: 0, s: 1, v: 1 }, 'ArrowRight', true)).toEqual({ h: 0, s: 1, v: 1 });
    expect(stepArea({ h: 0, s: 0, v: 0 }, 'ArrowDown', true)).toEqual({ h: 0, s: 0, v: 0 });
    expect(stepArea(base, 'a', false)).toBeNull();
    expect(stepArea(base, 'Enter', true)).toBeNull();
    expect(isStepKey('Tab')).toBe(false);
    expect(isStepKey('PageDown')).toBe(true);
  });

  it('many small steps reach the edge exactly, with no floating point drift', () => {
    let hsv = { h: 10, s: 0, v: 1 };
    for (let i = 0; i < 100; i += 1) hsv = stepArea(hsv, 'ArrowRight', false) ?? hsv;
    expect(hsv.s).toBe(1);
    for (let i = 0; i < 37; i += 1) hsv = stepArea(hsv, 'ArrowDown', false) ?? hsv;
    expect(hsv.v).toBe(0.63);
  });

  it('hue moves by one degree, 15 with Shift, 30 with the page keys, and clamps', () => {
    expect(stepHue(100, 'ArrowRight', false)).toBe(101);
    expect(stepHue(100, 'ArrowUp', false)).toBe(101);
    expect(stepHue(100, 'ArrowLeft', false)).toBe(99);
    expect(stepHue(100, 'ArrowDown', true)).toBe(85);
    expect(stepHue(100, 'PageUp', false)).toBe(130);
    expect(stepHue(100, 'PageDown', false)).toBe(70);
    expect(stepHue(100, 'Home', false)).toBe(0);
    expect(stepHue(100, 'End', false)).toBe(360);
    expect(stepHue(359.5, 'PageUp', true)).toBe(360);
    expect(stepHue(0, 'ArrowLeft', true)).toBe(0);
    expect(stepHue(5, 'x', false)).toBeNull();
  });

  it('a pointer position maps to saturation and brightness, held inside the area', () => {
    expect(areaPoint(base, 0, 0)).toEqual({ h: 200, s: 0, v: 1 });
    expect(areaPoint(base, 1, 1)).toEqual({ h: 200, s: 1, v: 0 });
    expect(areaPoint(base, 0.25, 0.5)).toEqual({ h: 200, s: 0.25, v: 0.5 });
    expect(areaPoint(base, -3, 9)).toEqual({ h: 200, s: 0, v: 0 });
    expect(huePoint(0.5)).toBe(180);
    expect(huePoint(2)).toBe(360);
    expect(huePoint(-1)).toBe(0);
  });
});
