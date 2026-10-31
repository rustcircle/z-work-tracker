#!/usr/bin/env node
// Called by Tauri's bundle.windows.signCommand for every binary it produces. With no credentials it
// reports UNSIGNED and succeeds. With partial credentials it fails, so a release is never silently
// unsigned by a typo. Secrets are read from the environment and never printed.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

export const DEFAULT_TIMESTAMP_URL = 'http://timestamp.digicert.com';

const AZURE = ['AZURE_SIGNING_ENDPOINT', 'AZURE_SIGNING_ACCOUNT', 'AZURE_SIGNING_PROFILE', 'AZURE_TENANT_ID', 'AZURE_CLIENT_ID', 'AZURE_CLIENT_SECRET'];
const PFX = ['WINDOWS_CERT_PFX_PATH', 'WINDOWS_CERT_PASSWORD'];

/** Returns { route } or { error }. Routes: none, azure, thumbprint, pfx-signtool, pfx-osslsigncode. */
export function chooseRoute(env, platform) {
  const set = (names) => names.filter((n) => env[n]);
  const azure = set(AZURE);
  const pfx = set(PFX);
  if (azure.length > 0) {
    const missing = AZURE.filter((n) => !env[n]);
    return missing.length ? { error: `Azure Artifact Signing is partly configured. Missing: ${missing.join(', ')}` } : { route: 'azure' };
  }
  if (env.WINDOWS_CERT_THUMBPRINT) {
    return platform === 'win32' ? { route: 'thumbprint' } : { error: 'WINDOWS_CERT_THUMBPRINT needs signtool, which only exists on Windows.' };
  }
  if (pfx.length > 0) {
    const missing = PFX.filter((n) => !env[n]);
    if (missing.length) return { error: `Certificate signing is partly configured. Missing: ${missing.join(', ')}` };
    return { route: platform === 'win32' ? 'pfx-signtool' : 'pfx-osslsigncode' };
  }
  return { route: 'none' };
}

/** The command to run. Always SHA-256 with an RFC 3161 timestamp. Secrets stay out of `shown`. */
export function buildCommand(route, env, file) {
  const ts = env.WINDOWS_TIMESTAMP_URL || DEFAULT_TIMESTAMP_URL;
  const signtool = env.SIGNTOOL_PATH || 'signtool';
  const hash = ['/fd', 'SHA256', '/tr', ts, '/td', 'SHA256'];
  switch (route) {
    case 'azure':
      return {
        program: 'trusted-signing-cli',
        args: ['-e', env.AZURE_SIGNING_ENDPOINT, '-a', env.AZURE_SIGNING_ACCOUNT, '-c', env.AZURE_SIGNING_PROFILE, '-d', 'Labor Tracker', file],
        shown: `trusted-signing-cli (account ${env.AZURE_SIGNING_ACCOUNT}) ${file}`,
      };
    case 'thumbprint':
      return { program: signtool, args: ['sign', '/sha1', env.WINDOWS_CERT_THUMBPRINT, ...hash, file], shown: `signtool sign /sha1 <thumbprint> ${file}` };
    case 'pfx-signtool':
      return {
        program: signtool,
        args: ['sign', '/f', env.WINDOWS_CERT_PFX_PATH, '/p', env.WINDOWS_CERT_PASSWORD, ...hash, file],
        shown: `signtool sign /f <pfx> ${file}`,
      };
    case 'pfx-osslsigncode':
      return {
        program: 'osslsigncode',
        args: ['sign', '-pkcs12', env.WINDOWS_CERT_PFX_PATH, '-h', 'sha256', '-ts', ts, '-in', file, '-out', `${file}.signed`],
        needsPassFile: true,
        shown: `osslsigncode sign -pkcs12 <pfx> ${file}`,
      };
    default:
      throw new Error(`no command for route ${route}`);
  }
}

function sign(file) {
  const { route, error } = chooseRoute(process.env, process.platform);
  if (error) {
    console.error(`SIGNING ERROR: ${error}`);
    return 1;
  }
  if (route === 'none') {
    console.log(`UNSIGNED: no signing credentials are set, leaving ${file} unsigned. See the README section on signing.`);
    return 0;
  }
  const cmd = buildCommand(route, process.env, file);
  console.log(`Signing: ${cmd.shown}`);
  let passDir = null;
  const args = [...cmd.args];
  if (cmd.needsPassFile) {
    passDir = mkdtempSync(join(tmpdir(), 'lt-sign-'));
    const passFile = join(passDir, 'pass');
    writeFileSync(passFile, process.env.WINDOWS_CERT_PASSWORD, { mode: 0o600 });
    args.splice(1, 0, '-readpass', passFile);
  }
  try {
    // stdout and stderr are captured and not echoed, since tools can print their arguments.
    const out = spawnSync(cmd.program, args, { encoding: 'utf8' });
    if (out.error) {
      console.error(`SIGNING ERROR: could not run ${cmd.program}: ${out.error.message}`);
      return 1;
    }
    if (out.status !== 0) {
      console.error(`SIGNING ERROR: ${cmd.program} exited with ${out.status}.`);
      return 1;
    }
    if (cmd.needsPassFile) renameSync(`${file}.signed`, file);
    console.log(`SIGNED: ${file}`);
    return 0;
  } finally {
    if (passDir) rmSync(passDir, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const file = process.argv[2];
  if (!file) {
    console.error('usage: windows-sign.mjs <file>');
    process.exit(2);
  }
  process.exit(sign(file));
}
