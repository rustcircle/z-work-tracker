// @vitest-environment node
import { spawnSync } from 'node:child_process';

import { describe, expect, it } from 'vitest';

import { DEFAULT_TIMESTAMP_URL, buildCommand, chooseRoute } from './windows-sign.mjs';

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
});
