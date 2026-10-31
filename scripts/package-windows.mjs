#!/usr/bin/env node
// Builds the Windows x64 NSIS installer from macOS with the GNU toolchain, then checks the PE imports
// (only DLLs that ship in Windows are allowed) and reports the signature state honestly.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const TARGET = 'x86_64-pc-windows-gnu';
const OBJDUMP = 'x86_64-w64-mingw32-objdump';
const FORBIDDEN = /^(libgcc|libstdc\+\+|libwinpthread|vcruntime|msvcp|ucrtbased|libssp)/i;
const out = process.env.LT_REPORT_DIR ?? '.';

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

const release = join('src-tauri', 'target', TARGET, 'release');
const nsisDir = join(release, 'bundle', 'nsis');
const installer = readdirSync(nsisDir).find((f) => f.endsWith('-setup.exe'));
if (!installer) {
  console.error('No installer was produced.');
  process.exit(1);
}
const installerPath = join(nsisDir, installer);
const exe = join(release, 'labor-tracker.exe');

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

const list = imports(exe);
const bad = list.filter((d) => FORBIDDEN.test(d));
const report = [
  `App exe: ${exe}`,
  `Size: ${statSync(exe).size} bytes`,
  'Imported DLLs:',
  ...list.map((d) => `  ${d}`),
  '',
  `Forbidden compiler-runtime DLLs: ${bad.length ? bad.join(', ') : 'none'}`,
  `Authenticode signature in app exe: ${hasCertificate(exe) ? 'present' : 'NONE (UNSIGNED)'}`,
  `Installer: ${installerPath}`,
  `Installer size: ${statSync(installerPath).size} bytes`,
  `Authenticode signature in installer: ${hasCertificate(installerPath) ? 'present' : 'NONE (UNSIGNED)'}`,
].join('\n');
console.log(report);
if (!existsSync(out)) mkdirSync(out, { recursive: true });
writeFileSync(join(out, 'pe-imports.txt'), `${report}\n`);
if (bad.length) {
  console.error(`The app needs DLLs Windows does not ship: ${bad.join(', ')}`);
  process.exit(1);
}
