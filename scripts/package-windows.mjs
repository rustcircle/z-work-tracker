#!/usr/bin/env node
// Builds the Windows x64 NSIS installer from macOS with the GNU toolchain, then checks the PE imports
// (only DLLs that ship in Windows are allowed) and reports the signature state honestly. Tauri signs a
// copy of the exe for the installer, so the signatures that count are read from inside the installer.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { chooseRoute } from './windows-sign.mjs';

const TARGET = 'x86_64-pc-windows-gnu';
const OBJDUMP = 'x86_64-w64-mingw32-objdump';
const FORBIDDEN = /^(libgcc|libstdc\+\+|libwinpthread|vcruntime|msvcp|ucrtbased|libssp)/i;
const out = process.env.ZWT_REPORT_DIR ?? '.';

for (const tool of ['makensis', 'x86_64-w64-mingw32-gcc', OBJDUMP]) {
  if (spawnSync('which', [tool]).status !== 0) {
    console.error(`Missing ${tool}. On macOS: brew install mingw-w64 nsis`);
    process.exit(1);
  }
}

// makensis from Homebrew aborts with std::bad_alloc when no UTF-8 locale is set.
const env = { ...process.env, LANG: 'en_US.UTF-8', LC_ALL: 'en_US.UTF-8' };
const build = spawnSync('pnpm', ['tauri', 'build', '--target', TARGET, '--bundles', 'nsis'], { stdio: 'inherit', env });
if (build.status !== 0) process.exit(build.status ?? 1);

// Cargo reads a relative CARGO_TARGET_DIR against the folder it runs in, which here is src-tauri.
const targetRoot = process.env.CARGO_TARGET_DIR ? resolve('src-tauri', process.env.CARGO_TARGET_DIR) : join('src-tauri', 'target');
const release = join(targetRoot, TARGET, 'release');
const nsisDir = join(release, 'bundle', 'nsis');
const installer = readdirSync(nsisDir).find((f) => f.endsWith('-setup.exe'));
if (!installer) {
  console.error('No installer was produced.');
  process.exit(1);
}
const installerPath = join(nsisDir, installer);
const exe = join(release, 'zWorkTracker.exe');

function imports(file) {
  const r = spawnSync(OBJDUMP, ['-p', file], { encoding: 'utf8', maxBuffer: 1 << 28 });
  return [...new Set([...r.stdout.matchAll(/DLL Name: (.+)/g)].map((m) => (m[1] ?? '').trim()))].sort();
}

/** True when the PE file has an Authenticode certificate table. */
function hasCertificate(file) {
  const buf = readFileSync(file);
  const pe = buf.readUInt32LE(0x3c);
  const magic = buf.readUInt16LE(pe + 24);
  const dirs = pe + 24 + (magic === 0x20b ? 112 : 96);
  return buf.readUInt32LE(dirs + 4 * 8 + 4) > 0;
}

/** Signature state of the files that get installed, or null when no 7-Zip can open the installer. */
function signaturesInside(installerFile) {
  const tool = ['7zz', '7z'].find((t) => spawnSync('which', [t]).status === 0);
  if (!tool) return null;
  const dir = join(release, 'installer-contents');
  rmSync(dir, { recursive: true, force: true });
  const names = ['zWorkTracker.exe', 'uninstall.exe', 'WebView2Loader.dll'];
  const opened = spawnSync(tool, ['x', '-y', `-o${dir}`, installerFile, ...names], { encoding: 'utf8', maxBuffer: 1 << 26 });
  if (opened.status !== 0) return null;
  const found = names.filter((n) => existsSync(join(dir, n))).map((n) => ({ name: n, signed: hasCertificate(join(dir, n)) }));
  rmSync(dir, { recursive: true, force: true });
  return found;
}

const list = imports(exe);
const bad = list.filter((d) => FORBIDDEN.test(d));
const signingWanted = chooseRoute(process.env, process.platform).route !== 'none';
const inside = signaturesInside(installerPath);
const report = [
  `App exe: ${exe}`,
  `Size: ${statSync(exe).size} bytes`,
  'Imported DLLs:',
  ...list.map((d) => `  ${d}`),
  '',
  `Forbidden compiler-runtime DLLs: ${bad.length ? bad.join(', ') : 'none'}`,
  `Installer: ${installerPath}`,
  `Installer size: ${statSync(installerPath).size} bytes`,
  `Authenticode signature in installer: ${hasCertificate(installerPath) ? 'present' : 'NONE (UNSIGNED)'}`,
  ...(inside === null
    ? ['Files inside the installer: not checked, needs 7-Zip (brew install sevenzip)']
    : inside.map((f) => `Authenticode signature in ${f.name} inside the installer: ${f.signed ? 'present' : 'NONE (UNSIGNED)'}`)),
].join('\n');
console.log(report);
if (!existsSync(out)) mkdirSync(out, { recursive: true });
writeFileSync(join(out, 'pe-imports.txt'), `${report}\n`);
if (bad.length) {
  console.error(`The app needs DLLs Windows does not ship: ${bad.join(', ')}`);
  process.exit(1);
}
if (signingWanted) {
  if (inside === null) {
    console.error('Signing was asked for, but the files inside the installer could not be checked. It needs 7-Zip: brew install sevenzip');
    process.exit(1);
  }
  const absent = ['zWorkTracker.exe', 'uninstall.exe'].filter((n) => !inside.some((f) => f.name === n));
  const missed = [...(hasCertificate(installerPath) ? [] : ['the installer']), ...inside.filter((f) => !f.signed).map((f) => f.name)];
  if (absent.length || missed.length) {
    console.error(`Signing was asked for, but these are unsigned: ${[...missed, ...absent.map((n) => `${n} (not found)`)].join(', ')}`);
    process.exit(1);
  }
}
