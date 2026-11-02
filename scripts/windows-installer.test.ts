// @vitest-environment node
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { findInstaller } from './windows-installer.mjs';

const conf = { productName: 'zWorkTracker', version: '0.2.0' };
const older = 'zWorkTracker_0.1.0_x64-setup.exe';
const current = 'zWorkTracker_0.2.0_x64-setup.exe';

describe('finding the installer of this build', () => {
  const made: string[] = [];
  afterEach(() => {
    for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
  });
  /** A stand-in for the bundle/nsis folder, holding empty files with these names. */
  function nsisWith(...names: string[]) {
    const dir = mkdtempSync(join(tmpdir(), 'installer-test-'));
    made.push(dir);
    for (const name of names) writeFileSync(join(dir, name), '');
    return dir;
  }

  it('takes the installer named by the config, not an older one beside it', () => {
    const dir = nsisWith(older, current);
    expect(findInstaller(dir, conf)).toEqual({ path: join(dir, current) });
  });

  it('says which file it expected, and uses no older installer, when this version has none', () => {
    const found = findInstaller(nsisWith(older), conf);
    expect(found.path).toBeUndefined();
    expect(found.error).toContain(current);
  });

  it('says the same when the folder is not there at all', () => {
    const found = findInstaller(join(nsisWith(), 'nsis'), conf);
    expect(found.path).toBeUndefined();
    expect(found.error).toContain(current);
  });

  it('does not guess a name when the config has no product name or version', () => {
    const dir = nsisWith(older, current);
    for (const partial of [{ productName: 'zWorkTracker' }, { version: '0.2.0' }, { productName: '', version: '0.2.0' }, {}]) {
      const found = findInstaller(dir, partial);
      expect(found.path).toBeUndefined();
      expect(found.error).toContain('tauri.conf.json');
    }
  });
});
