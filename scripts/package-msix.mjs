#!/usr/bin/env node
// Packs the Windows x64 build as an MSIX for upload to the Microsoft Store, from macOS, with makemsix from Microsoft's MSIX
// Packaging SDK. It packs the exe and WebView2Loader.dll that `pnpm package:windows` left in the release folder, and builds
// nothing unless --build is passed. The package is not signed: the Store signs what it publishes. The Store identity is
// Partner Center's to give, so it has no defaults. The README section on the Microsoft Store package has the setup.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

import { ASSETS, EXECUTABLE, buildManifest, embeddedVersion, msixVersion, readIdentity, resourceCopies } from './msix-manifest.mjs';

const TARGET = 'x86_64-pc-windows-gnu';
const LOADER = 'WebView2Loader.dll';
const SIPS = '/usr/bin/sips';
const UNZIP = '/usr/bin/unzip';

const root = resolve(import.meta.dirname, '..');
const tauriDir = join(root, 'src-tauri');

// The package while it is being made, under a name that is not a package's. A run that fails takes it away, and it is
// renamed only once it has passed every check, so nothing else is ever left under the real name.
let partial = null;

function fail(message) {
  if (partial) rmSync(partial, { force: true });
  console.error(message);
  process.exit(1);
}

/** An attribute value or element text read back from the manifest, with its XML escapes undone, as the Store sees it. */
function unescapeXml(text) {
  const characters = { lt: '<', gt: '>', quot: '"', apos: "'", amp: '&' };
  return text.replace(/&(lt|gt|quot|apos|amp);/g, (_, name) => characters[name]);
}

const unknown = process.argv.slice(2).filter((arg) => arg !== '--build');
if (unknown.length > 0) fail(`Unknown argument: ${unknown.join(' ')}. The only option is --build, which builds the Windows app first.`);
const rebuild = process.argv.includes('--build');

const conf = JSON.parse(readFileSync(join(tauriDir, 'tauri.conf.json'), 'utf8'));
const productName = conf.productName;
const description = conf.bundle?.shortDescription;
const unnamed = [['productName', productName], ['bundle.shortDescription', description]].filter(([, value]) => typeof value !== 'string' || !value);
if (unnamed.length > 0) fail(`src-tauri/tauri.conf.json needs ${unnamed.map(([key]) => key).join(' and ')}.`);

// Everything that can be wrong with the settings is reported together, before any work starts.
const problems = [];
let version;
let identity;
try {
  version = msixVersion(conf.version);
} catch (error) {
  problems.push(`The version in src-tauri/tauri.conf.json: ${error.message}`);
}
try {
  identity = readIdentity(process.env);
} catch (error) {
  problems.push(error.message);
}
if (problems.length > 0) fail(problems.join('\n'));

// Cargo reads a relative CARGO_TARGET_DIR against the folder it runs in, which here is src-tauri. The same rule as package-windows.mjs.
const targetRoot = process.env.CARGO_TARGET_DIR ? resolve(tauriDir, process.env.CARGO_TARGET_DIR) : join(tauriDir, 'target');
const release = join(targetRoot, TARGET, 'release');
const exe = join(release, EXECUTABLE);

// A package from an earlier run goes first, so a run that fails leaves nothing that could be taken for this one.
const outDir = process.env.ZWT_MSIX_OUT_DIR ? resolve(process.env.ZWT_MSIX_OUT_DIR) : join(release, 'bundle', 'msix');
const msix = join(outDir, `${productName}_${version}_x64.msix`);
partial = `${msix}.partial`;
rmSync(msix, { force: true });
rmSync(partial, { force: true });

const makemsix = resolve(process.env.ZWT_MAKEMSIX || join(homedir(), 'msix-packaging', '.vs', 'bin', 'makemsix'));
if (!existsSync(makemsix)) {
  fail(
    `makemsix was not found at ${makemsix}. It is the command-line tool of Microsoft's MSIX Packaging SDK (https://github.com/microsoft/msix-packaging). ` +
      'Build it on this Mac with ./makemac.sh --pack, which puts it in .vs/bin, or set ZWT_MAKEMSIX to a copy.',
  );
}
for (const tool of [SIPS, UNZIP]) {
  if (!existsSync(tool)) fail(`Missing ${tool}. This script runs on macOS, which includes it.`);
}

if (rebuild) {
  for (const tool of ['makensis', 'x86_64-w64-mingw32-gcc']) {
    if (spawnSync('which', [tool]).status !== 0) fail(`Missing ${tool}. On macOS: brew install mingw-w64 nsis`);
  }
  // makensis from Homebrew aborts with std::bad_alloc when no UTF-8 locale is set.
  const env = { ...process.env, LANG: 'en_US.UTF-8', LC_ALL: 'en_US.UTF-8' };
  const build = spawnSync('pnpm', ['tauri', 'build', '--target', TARGET, '--bundles', 'nsis'], { stdio: 'inherit', env, cwd: root });
  if (build.error) console.error(`Could not run pnpm: ${build.error.message}`);
  if (build.status !== 0) process.exit(build.status ?? 1);
}

const absent = [exe, join(release, LOADER)].filter((file) => !existsSync(file));
if (absent.length > 0) fail(`Not found: ${absent.join(', ')}. Build the Windows app first with pnpm package:windows, or run this again with --build.`);

// Nothing is rebuilt without --build, so the exe could be left over from another version. The Store would take it all the same.
// The same version can still hide an older build of it, which is why the report says when this exe was built.
const exeBytes = readFileSync(exe);
const built = embeddedVersion(exeBytes);
if (built !== conf.version) {
  fail(
    built === null
      ? `Could not read a version from ${exe}, so it can't be confirmed as ${conf.version}. Build it again with --build.`
      : `${exe} is version ${built}, but src-tauri/tauri.conf.json says ${conf.version}. Run this again with --build to make one of that version.`,
  );
}

// The staging folder holds exactly what goes into the package, and is wiped each time.
const stage = join(release, 'msix-stage');
rmSync(stage, { recursive: true, force: true });
mkdirSync(join(stage, 'Assets'), { recursive: true });
const staged = [];

function stageFile(name, source) {
  mkdirSync(dirname(join(stage, name)), { recursive: true });
  copyFileSync(source, join(stage, name));
  staged.push(name);
}

stageFile(EXECUTABLE, exe);
stageFile(LOADER, join(release, LOADER));

// The licenses go where bundle.resources puts them in the installer.
let copies;
try {
  copies = resourceCopies(conf.bundle?.resources, tauriDir);
} catch (error) {
  fail(error.message);
}
for (const { from, to } of copies) {
  if (!existsSync(from)) fail(`bundle.resources names a file that is not there: ${from}`);
  stageFile(to, from);
}

// The store logo and the tiles, cut from the app icon.
const icon = join(tauriDir, 'icons', 'icon.png');
if (!existsSync(icon)) fail(`The app icon is missing: ${icon}`);
for (const [image, size] of Object.entries(ASSETS)) {
  const file = join(stage, 'Assets', `${image}.png`);
  const cut = spawnSync(SIPS, ['-s', 'format', 'png', '-z', String(size), String(size), icon, '--out', file], { encoding: 'utf8' });
  if (cut.status !== 0 || !existsSync(file)) fail(`sips could not cut ${image}.png from ${icon}:\n${cut.stdout}${cut.stderr}`.trim());
  staged.push(`Assets/${image}.png`);
}

writeFileSync(join(stage, 'AppxManifest.xml'), buildManifest({ ...identity, displayName: productName, description, version }));
staged.push('AppxManifest.xml');

mkdirSync(outDir, { recursive: true });

console.log(`Packing ${productName} ${conf.version} from ${release} as package version ${version}`);
// makemsix finds libmsix.dylib through an absolute path written into it when it was built. If that folder has since moved,
// the copy in ../lib beside makemsix's own folder is the fallback.
const lib = resolve(dirname(makemsix), '..', 'lib');
const packEnv = { ...process.env, DYLD_FALLBACK_LIBRARY_PATH: [lib, process.env.DYLD_FALLBACK_LIBRARY_PATH].filter(Boolean).join(':') };
const pack = spawnSync(makemsix, ['pack', '-d', stage, '-p', partial], { encoding: 'utf8', env: packEnv, maxBuffer: 1 << 26 });
const said = `${pack.stdout ?? ''}${pack.stderr ?? ''}`.trim();
if (pack.error) fail(`Could not run ${makemsix}: ${pack.error.message}`);
if (pack.status !== 0) fail(`makemsix failed (exit ${pack.status}):\n${said}`);
if (!existsSync(partial)) fail(`makemsix finished, but wrote no package at ${partial}.\n${said}`.trim());
if (said) console.log(said);

// Look inside what was made, rather than trusting that makemsix exiting 0 means the package is whole. makemsix checks the
// manifest against Microsoft's schemas, and nothing more: not that the files it names are there, nor the Store's own rules.
const listing = spawnSync(UNZIP, ['-Z1', partial], { encoding: 'utf8', maxBuffer: 1 << 26 });
if (listing.status !== 0) fail(`${partial} can't be read as a zip file:\n${listing.stderr}`);
const entries = listing.stdout.split('\n').filter(Boolean);
const lacking = ['AppxBlockMap.xml', '[Content_Types].xml', ...staged].filter((name) => !entries.includes(name));
if (lacking.length > 0) fail(`The package lacks: ${lacking.join(', ')}`);

const manifest = spawnSync(UNZIP, ['-p', partial, 'AppxManifest.xml'], { encoding: 'utf8', maxBuffer: 1 << 24 }).stdout ?? '';
const identityTag = /<Identity\s[^>]*>/.exec(manifest)?.[0] ?? '';
const attribute = (name) => new RegExp(`\\s${name}="([^"]*)"`).exec(identityTag)?.[1];
const shown = /<PublisherDisplayName>([^<]*)</.exec(manifest)?.[1];
if (!attribute('Name') || !attribute('Publisher') || !attribute('Version') || !shown) fail('The manifest inside the package has no complete identity.');

// Only now is it a package: one that passed every check.
renameSync(partial, msix);
partial = null;

console.log(
  [
    '',
    `Package: ${msix}`,
    `Size: ${statSync(msix).size} bytes`,
    `SHA-256: ${createHash('sha256').update(readFileSync(msix)).digest('hex')}`,
    `Files in the package: ${entries.length}`,
    `App exe: version ${built}, built ${statSync(exe).mtime.toISOString()}, SHA-256 ${createHash('sha256').update(exeBytes).digest('hex')}`,
    'Identity in the manifest inside it:',
    `  Name: ${unescapeXml(attribute('Name'))}`,
    `  Publisher: ${unescapeXml(attribute('Publisher'))}`,
    `  Publisher display name: ${unescapeXml(shown)}`,
    `  Version: ${attribute('Version')}`,
    entries.includes('AppxSignature.p7x') ? 'Signed: it carries a signature, which the Store replaces' : 'Unsigned: the Store signs it',
  ].join('\n'),
);
