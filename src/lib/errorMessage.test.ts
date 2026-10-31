import { describe, expect, it } from 'vitest';

import { GENERIC_ERROR, errorCode, errorMessage } from './errorMessage';

describe('errorMessage', () => {
  it('uses the text a failure carries', () => {
    expect(errorMessage({ code: 'conflict', message: 'a tag named "x" already exists' })).toBe('a tag named "x" already exists');
    expect(errorMessage(new Error('boom'))).toBe('boom');
    expect(errorMessage('plain text')).toBe('plain text');
    expect(errorMessage(404)).toBe('404');
  });

  it('never prints an object as [object Object]', () => {
    for (const odd of [{}, { code: 'x' }, { message: {} }, { message: null }, [], null, undefined, Symbol('s')]) {
      expect(errorMessage(odd)).toBe(GENERIC_ERROR);
    }
  });

  it('reads the code only when there is one', () => {
    expect(errorCode({ code: 'overlap', message: 'm' })).toBe('overlap');
    expect(errorCode(new Error('x'))).toBe('');
    expect(errorCode(null)).toBe('');
  });
});
