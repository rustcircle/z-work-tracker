// @vitest-environment node
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { DEFAULT_TIMESTAMP_URL, buildCommand, chooseRoute, redact } from './windows-sign.mjs';

const azure = {
  AZURE_SIGNING_ENDPOINT: 'https://x', AZURE_SIGNING_ACCOUNT: 'acc', AZURE_SIGNING_PROFILE: 'prof',
  AZURE_TENANT_ID: 't', AZURE_CLIENT_ID: 'c', AZURE_CLIENT_SECRET: 'SENTINEL-SECRET',
};

describe('signing route', () => {
  it('stays unsigned without credentials', () => {
    expect(chooseRoute({}, 'darwin')).toEqual({ route: 'none' });
  });

  it('picks Azure first, and fails on partial credentials', () => {
    expect(chooseRoute(azure, 'darwin')).toEqual({ route: 'azure' });
    expect(chooseRoute({ AZURE_CLIENT_ID: 'c' }, 'win32').error).toContain('AZURE_SIGNING_ENDPOINT');
    expect(chooseRoute({ WINDOWS_CERT_PFX_PATH: 'a.pfx' }, 'darwin').error).toContain('WINDOWS_CERT_PASSWORD');
  });

  it('uses signtool on Windows and osslsigncode elsewhere', () => {
    const pfx = { WINDOWS_CERT_PFX_PATH: 'a.pfx', WINDOWS_CERT_PASSWORD: 'SENTINEL-SECRET' };
    expect(chooseRoute(pfx, 'win32').route).toBe('pfx-signtool');
    expect(chooseRoute(pfx, 'darwin').route).toBe('pfx-osslsigncode');
    expect(chooseRoute({ WINDOWS_CERT_THUMBPRINT: 'ab' }, 'win32').route).toBe('thumbprint');
    expect(chooseRoute({ WINDOWS_CERT_THUMBPRINT: 'ab' }, 'darwin').error).toBeDefined();
  });

  it('always asks for SHA-256 and an RFC 3161 timestamp', () => {
    const t = buildCommand('thumbprint', { WINDOWS_CERT_THUMBPRINT: 'ab' }, 'f.exe');
    expect(t.args).toEqual(expect.arrayContaining(['/fd', 'SHA256', '/tr', DEFAULT_TIMESTAMP_URL, '/td', 'SHA256']));
    const o = buildCommand('pfx-osslsigncode', { WINDOWS_CERT_PFX_PATH: 'a.pfx', WINDOWS_CERT_PASSWORD: 'x' }, 'f.exe');
    expect(o.args).toEqual(expect.arrayContaining(['-h', 'sha256', '-ts', DEFAULT_TIMESTAMP_URL]));
  });

  it('never shows or passes a secret where it could be logged', () => {
    for (const [route, env] of [
      ['azure', azure],
      ['pfx-signtool', { WINDOWS_CERT_PFX_PATH: 'a.pfx', WINDOWS_CERT_PASSWORD: 'SENTINEL-SECRET' }],
      ['pfx-osslsigncode', { WINDOWS_CERT_PFX_PATH: 'a.pfx', WINDOWS_CERT_PASSWORD: 'SENTINEL-SECRET' }],
    ] as const) {
      expect(buildCommand(route, env, 'f.exe').shown).not.toContain('SENTINEL');
    }
    expect(buildCommand('azure', azure, 'f.exe').args.join(' ')).not.toContain('SENTINEL');
  });

  it('prints UNSIGNED and succeeds with no credentials', () => {
    const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(AZURE_|WINDOWS_CERT)/.test(k)));
    const out = spawnSync(process.execPath, ['scripts/windows-sign.mjs', 'x.exe'], { encoding: 'utf8', env });
    expect(out.status).toBe(0);
    expect(out.stdout).toContain('UNSIGNED');
  });

  it('fails the build on partial credentials and does not echo them', () => {
    const out = spawnSync(process.execPath, ['scripts/windows-sign.mjs', 'x.exe'], {
      encoding: 'utf8',
      env: { ...process.env, AZURE_CLIENT_SECRET: 'SENTINEL-SECRET' },
    });
    expect(out.status).toBe(1);
    expect(out.stdout + out.stderr).not.toContain('SENTINEL');
  });

  it('takes the password, client secret, thumbprint and PFX path out of what a tool said', () => {
    const env = { WINDOWS_CERT_PASSWORD: 'pw-1', AZURE_CLIENT_SECRET: 'sec-2', WINDOWS_CERT_THUMBPRINT: 'th-3', WINDOWS_CERT_PFX_PATH: '/x/a.pfx' };
    expect(redact('bad pw-1 sec-2 th-3 /x/a.pfx, twice pw-1', env)).toBe('bad <hidden> <hidden> <hidden> <hidden>, twice <hidden>');
    expect(redact('nothing set', {})).toBe('nothing set');
  });

  // A stand-in osslsigncode, so this runs anywhere with a POSIX shell.
  describe.skipIf(process.platform === 'win32')('running the tool', () => {
    function run(script: string) {
      const dir = mkdtempSync(join(tmpdir(), 'sign-test-'));
      const tool = join(dir, 'osslsigncode');
      writeFileSync(tool, `#!/bin/sh\n${script}\n`);
      chmodSync(tool, 0o755);
      const file = join(dir, 'f.exe');
      writeFileSync(file, 'unsigned');
      const out = spawnSync(process.execPath, ['scripts/windows-sign.mjs', file], {
        encoding: 'utf8',
        env: { PATH: `${dir}${delimiter}${process.env.PATH ?? ''}`, WINDOWS_CERT_PFX_PATH: 'SENTINEL.pfx', WINDOWS_CERT_PASSWORD: 'SENTINEL-SECRET', WINDOWS_SIGN_RETRY_MS: '1', COUNT: join(dir, 'count') },
      });
      const content = readFileSync(file, 'utf8');
      const attempts = spawnSync('wc', ['-l', join(dir, 'count')], { encoding: 'utf8' }).stdout.trim().split(' ')[0];
      rmSync(dir, { recursive: true, force: true });
      return { ...out, content, attempts };
    }
    /** Writes the signed copy where the script asks for it. */
    const succeed = 'while [ "$1" != "-out" ]; do shift; done; echo signed > "$2"';

    it('gives the tool no socket for stdin, which stops OpenSSL reading a PFX on macOS', () => {
      const r = run(`if [ -S /dev/stdin ]; then echo stdin is a socket >&2; exit 7; fi\n${succeed}`);
      expect(r.stderr).toBe('');
      expect(r.status).toBe(0);
      expect(r.content).toBe('signed\n');
    });

    it('tries again when the tool fails once, as a timestamp server can', () => {
      const r = run(`echo x >> "$COUNT"\nif [ "$(wc -l < "$COUNT")" -lt 2 ]; then exit 1; fi\n${succeed}`);
      expect(r.status).toBe(0);
      expect(r.attempts).toBe('2');
      expect(r.content).toBe('signed\n');
    });

    it('gives up after three tries, says why without the secrets, and leaves the file alone', () => {
      const r = run('echo x >> "$COUNT"; echo "could not read SENTINEL.pfx with SENTINEL-SECRET" >&2; exit 1');
      expect(r.status).toBe(1);
      expect(r.attempts).toBe('3');
      expect(r.stderr).toContain('could not read <hidden> with <hidden>');
      expect(r.stdout + r.stderr).not.toContain('SENTINEL');
      expect(r.content).toBe('unsigned');
    });
  });
});
