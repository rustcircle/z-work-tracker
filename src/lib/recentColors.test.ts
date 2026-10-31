import { afterEach, describe, expect, it, vi } from 'vitest';

import { RECENT_KEY, RECENT_MAX, loadRecent, parseRecent, pushRecent, rememberColor } from './recentColors';

afterEach(() => {
  vi.restoreAllMocks();
  window.localStorage.clear();
});

describe('pushRecent', () => {
  it('puts the newest first, without repeats, normalised, at most eight', () => {
    expect(pushRecent(['#111111', '#222222'], '#ABC')).toEqual(['#aabbcc', '#111111', '#222222']);
    expect(pushRecent(['#111111', '#222222'], '#222222')).toEqual(['#222222', '#111111']);
    const many = Array.from({ length: 12 }, (_, i) => `#0000${i.toString(16).padStart(2, '0')}`);
    expect(pushRecent(many, '#ffffff')).toHaveLength(RECENT_MAX);
    expect(pushRecent(['#111111'], 'red')).toEqual(['#111111']);
  });
});

describe('parseRecent', () => {
  it('survives bad storage content', () => {
    expect(parseRecent(null)).toEqual([]);
    expect(parseRecent('')).toEqual([]);
    expect(parseRecent('{')).toEqual([]);
    expect(parseRecent('{"a":1}')).toEqual([]);
    expect(parseRecent('["#ABCDEF", 5, "nope", "#abcdef", "#123"]')).toEqual(['#abcdef', '#112233']);
  });
});

describe('storage', () => {
  it('remembers and reloads colours', () => {
    expect(loadRecent()).toEqual([]);
    rememberColor('#AABBCC');
    expect(rememberColor('#112233')).toEqual(['#112233', '#aabbcc']);
    expect(loadRecent()).toEqual(['#112233', '#aabbcc']);
    expect(window.localStorage.getItem(RECENT_KEY)).toBe('["#112233","#aabbcc"]');
  });

  it('is fine when storage throws on read and on write', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('full');
    });
    expect(loadRecent()).toEqual([]);
    expect(rememberColor('#112233')).toEqual(['#112233']);
  });
});
