#!/usr/bin/env node
// Packs the Windows x64 build as MSIX packages, from macOS, with makemsix from Microsoft's MSIX Packaging SDK. It packs the exe and
// WebView2Loader.dll that `pnpm package:windows` left in the release folder, and builds nothing unless --build is passed. The logo, the
// tiles and the taskbar icons are cut from src-tauri/icons/icon.png with sips, as listed by assetImages() in msix-manifest.mjs.
// One run makes two packages from those same files, which differ only in AppxManifest.xml: the Store package, with the identity
// Partner Center issued for the app, to upload there, and a test package, with an identity of our own, to sign by hand and try on
// a PC. --identity store or --identity test makes just one of them. Neither is signed here: the Store signs what it publishes.
// The identities are in msix-manifest.mjs. The README section on the Microsoft Store package has the setup.
// A package also gets the resources.pri made for it on Windows, which Windows finds the target-size and unplated images through, if there is
// one: packaging/msix/<package>/resources.pri, or the file that ZWT_MSIX_PRI_STORE or ZWT_MSIX_PRI_TEST names. It is checked to be a PRI file
// for that package's identity, and to list every image of the package, before it is packed. Nothing here can make one: `pnpm msix:pri`
// (make-pri.mjs) does, with a Windows VM; see resourceIndexFor in msix-manifest.mjs.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

import {
  EXECUTABLE,
  RESOURCE_INDEX,
  assetImages,
  embeddedVersion,
  identityOf,
  lackingAssets,
  manifestFor,
  msixFileName,
  msixVersion,
  packageFamilyName,
  parseArguments,
  resourceCopies,
  resourceIndexFor,
  resourceIndexVariable,
  retiredVariables,
} from './msix-manifest.mjs';
import { SIPS, cargoTargetRoot, cutAssetImages, readAppConf } from './msix-stage.mjs';

const TARGET = 'x86_64-pc-windows-gnu';
const LOADER = 'WebView2Loader.dll';
const UNZIP = '/usr/bin/unzip';

const root = resolve(import.meta.dirname, '..');
const tauriDir = join(root, 'src-tauri');

// What each package is for, and what is left to do to it.
const PURPOSE = {
  store: 'the Microsoft Store: upload this one in Partner Center',
  test: 'trying on a PC: sign it with a certificate whose subject is its Publisher, then install it',
};
const UNSIGNED = {
  store: 'Unsigned: the Store signs it',
  test: 'Unsigned: sign it yourself before installing it',
};
const SIGNED = {
  store: 'Signed: it carries a signature, which the Store replaces',
  test: 'Signed: it carries a signature',
};
/**
 * Said at the end when a package has no resources.pri, `lacking` being the results of those that have none. Windows finds the target-size and
 * unplated images, which are what draws the logo without a plate in the taskbar and Start, only through that index (Microsoft: "Generating MSIX
 * package components"). makemsix doesn't make one, and makepri, which does, is a Windows program, part of the Windows SDK: so this says how to
 * make one there, from a copy of the `stage` folder and the package's own manifest, and where to leave it for the next run.
 */
function noIndexNote(lacking, stage) {
  const names = lacking.map(({ kind }) => kind);
  return [
    `No ${RESOURCE_INDEX} in the ${names.join(' and ')} package${names.length === 1 ? '' : 's'}: without one, Windows can't find the target-size and unplated images, so the taskbar and Start use the plain logo and still draw it on a plate.`,
    "makemsix can't make the index. makepri, which can, is a Windows program, part of the Windows SDK. From this Mac, with the Windows VM running, `pnpm msix:pri` makes both and saves them where step 5 below says (the README has the steps). To make one by hand, on Windows, for each package:",
    `  1. Copy the stage folder (${stage}) to the PC and put in the copy the AppxManifest.xml of the package it is for (take it from its .msix: unzip -p <package> AppxManifest.xml). Below, <stage> is that copy.`,
    '  2. makepri createconfig /cf priconfig.xml /dq en-US /o /pv 10.0.0',
    '  3. Delete the <packaging> element from priconfig.xml.',
    `  4. makepri new /cf priconfig.xml /pr <stage> /mn <stage>\\AppxManifest.xml /of <stage>\\${RESOURCE_INDEX} /o`,
    `  5. Save the result in this repo, and run this again: ${names.map((kind) => `${kind}: packaging/msix/${kind}/${RESOURCE_INDEX} (or the file named in ${resourceIndexVariable(kind)})`).join('; ')}.`,
    'The index depends on the identity and on which images there are, not on the version, so one made now serves the next versions too. This script checks that it is a PRI file made for the identity of its package.',
  ].join('\n');
}

/** What `resourceIndexFor` reads files with: the bytes, or null if there is no such file. Any other failure, a folder in its place for one, is thrown. */
function readIfThere(file) {
  try {
    return readFileSync(file);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

// The package while it is being made, under a name that is not a package's, and the packages this run has finished. A run that
// fails takes them all away, and a package is renamed only once it has passed every check, so nothing else is ever left under
// the real names.
let partial = null;
const made = [];

function fail(message) {
  if (partial) rmSync(partial, { force: true });
  for (const file of made) rmSync(file, { force: true });
  console.error(message);
  process.exit(1);
}

/** An attribute value or element text read back from the manifest, with its XML escapes undone, as the Store sees it. */
function unescapeXml(text) {
  const characters = { lt: '<', gt: '>', quot: '"', apos: "'", amp: '&' };
  return text.replace(/&(lt|gt|quot|apos|amp);/g, (_, name) => characters[name]);
}

let options;
try {
  options = parseArguments(process.argv.slice(2));
} catch (error) {
  fail(error.message);
}
const { build: rebuild, kinds } = options;

// The Store identity used to come from these. A value left in a shell must not pass for an override, so say it is ignored.
const retired = retiredVariables(process.env);
if (retired.length > 0) {
  const [one, it] = retired.length === 1 ? ['is', 'it'] : ['are', 'them'];
  console.warn(`${retired.join(', ')} ${one} set, and no longer read: the identities are in scripts/msix-manifest.mjs. Unset ${it} to stop this message.`);
}

let conf;
try {
  conf = readAppConf(tauriDir);
} catch (error) {
  fail(error.message);
}
const productName = conf.productName;
const description = conf.bundle?.shortDescription;

// Everything that can be wrong with the settings is reported together, before any work starts.
const problems = [];
let version;
const identities = {};
try {
  version = msixVersion(conf.version);
} catch (error) {
  problems.push(`The version in src-tauri/tauri.conf.json: ${error.message}`);
}
for (const kind of kinds) {
  try {
    identities[kind] = identityOf(kind);
  } catch (error) {
    problems.push(`The ${kind} identity in scripts/msix-manifest.mjs: ${error.message}`);
  }
}
if (problems.length > 0) fail(problems.join('\n'));

const release = join(cargoTargetRoot(tauriDir, process.env), TARGET, 'release');
const exe = join(release, EXECUTABLE);

// Packages from an earlier run go first, so a run that fails leaves nothing that could be taken for this one's.
const outDir = process.env.ZWT_MSIX_OUT_DIR ? resolve(process.env.ZWT_MSIX_OUT_DIR) : join(release, 'bundle', 'msix');
const packages = kinds.map((kind) => ({ kind, file: join(outDir, msixFileName(productName, version, kind)) }));
for (const { file } of packages) {
  rmSync(file, { force: true });
  rmSync(`${file}.partial`, { force: true });
}

// The resources.pri of each package, if it has one: { file, bytes, variable }, checked to be a PRI file that names that package's identity.
// They are read only now, with the packages of the earlier run gone, so a run that fails over a wrong one leaves none of the same name.
const indexes = {};
const wrongIndexes = [];
for (const kind of kinds) {
  try {
    indexes[kind] = resourceIndexFor(kind, { env: process.env, root, read: readIfThere });
  } catch (error) {
    wrongIndexes.push(error.message);
  }
}
if (wrongIndexes.length > 0) fail(wrongIndexes.join('\n'));

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

// The staging folder holds exactly what goes into the packages, and is wiped each time. Every package is packed from it: only
// AppxManifest.xml, which each package gets in turn, differs.
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

// The store logo, the tiles and the taskbar icons, cut from the app icon: the list is assetImages() in msix-manifest.mjs, and both
// packages get all of it. make-pri.mjs cuts the same images, with the same function, for the resource index.
try {
  staged.push(...cutAssetImages({ icon: join(tauriDir, 'icons', 'icon.png'), dir: stage }));
} catch (error) {
  fail(error.message);
}

mkdirSync(outDir, { recursive: true });

console.log(`Packing ${productName} ${conf.version} from ${release} as package version ${version}: ${kinds.join(' and ')}`);
// makemsix finds libmsix.dylib through an absolute path written into it when it was built. If that folder has since moved,
// the copy in ../lib beside makemsix's own folder is the fallback.
const lib = resolve(dirname(makemsix), '..', 'lib');
const packEnv = { ...process.env, DYLD_FALLBACK_LIBRARY_PATH: [lib, process.env.DYLD_FALLBACK_LIBRARY_PATH].filter(Boolean).join(':') };

/** Makes one package from the staged files and returns what was read back from it. It fails the whole run if anything is wrong. */
function pack({ kind, file }) {
  const identity = identities[kind];
  const index = indexes[kind];
  writeFileSync(join(stage, 'AppxManifest.xml'), manifestFor(kind, { displayName: productName, description, version }));
  // The stage is shared, and the index of one package is wrong for the other: so it is in the stage only while its own package is packed.
  if (index) writeFileSync(join(stage, RESOURCE_INDEX), index.bytes);

  partial = `${file}.partial`;
  const run = spawnSync(makemsix, ['pack', '-d', stage, '-p', partial], { encoding: 'utf8', env: packEnv, maxBuffer: 1 << 26 });
  rmSync(join(stage, RESOURCE_INDEX), { force: true });
  const said = `${run.stdout ?? ''}${run.stderr ?? ''}`.trim();
  if (run.error) fail(`Could not run ${makemsix}: ${run.error.message}`);
  if (run.status !== 0) fail(`makemsix failed on the ${kind} package (exit ${run.status}):\n${said}`);
  if (!existsSync(partial)) fail(`makemsix finished, but wrote no package at ${partial}.\n${said}`.trim());
  if (said) console.log(said);

  // Look inside what was made, rather than trusting that makemsix exiting 0 means the package is whole. makemsix checks the
  // manifest against Microsoft's schemas, and nothing more: not that the files it names are there, nor the Store's own rules.
  const listing = spawnSync(UNZIP, ['-Z1', partial], { encoding: 'utf8', maxBuffer: 1 << 26 });
  if (listing.status !== 0) fail(`${partial} can't be read as a zip file:\n${listing.stderr}`);
  const entries = listing.stdout.split('\n').filter(Boolean);
  const lacking = ['AppxBlockMap.xml', '[Content_Types].xml', 'AppxManifest.xml', ...staged, ...(index ? [RESOURCE_INDEX] : [])].filter((name) => !entries.includes(name));
  if (lacking.length > 0) fail(`The ${kind} package lacks: ${lacking.join(', ')}`);
  // Every image of the list, whatever staging added: both packages carry the same set.
  const noImages = lackingAssets(entries);
  if (noImages.length > 0) fail(`The ${kind} package lacks ${noImages.length} of its ${assetImages().length} images: ${noImages.join(', ')}`);
  // The index in the package is the file that was checked, whole: Windows reads one for the identity it names, and this one is for this package's.
  if (index) {
    const inside = spawnSync(UNZIP, ['-p', partial, RESOURCE_INDEX], { maxBuffer: 1 << 26 }).stdout;
    if (!Buffer.isBuffer(inside) || !index.bytes.equals(inside)) fail(`The ${RESOURCE_INDEX} inside the ${kind} package is not the file it was made from, ${index.file}.`);
  }

  const manifest = spawnSync(UNZIP, ['-p', partial, 'AppxManifest.xml'], { encoding: 'utf8', maxBuffer: 1 << 24 }).stdout ?? '';
  const identityTag = /<Identity\s[^>]*>/.exec(manifest)?.[0] ?? '';
  const attribute = (name) => new RegExp(`\\s${name}="([^"]*)"`).exec(identityTag)?.[1];
  const shown = /<PublisherDisplayName>([^<]*)</.exec(manifest)?.[1];
  if (!attribute('Name') || !attribute('Publisher') || !attribute('Version') || !shown) fail(`The manifest inside the ${kind} package has no complete identity.`);
  const read = { name: unescapeXml(attribute('Name')), publisher: unescapeXml(attribute('Publisher')), publisherDisplayName: unescapeXml(shown), version: attribute('Version') };
  const wrong = [
    ['Name', read.name, identity.name],
    ['Publisher', read.publisher, identity.publisher],
    ['Publisher display name', read.publisherDisplayName, identity.publisherDisplayName],
    ['Version', read.version, version],
  ].filter(([, got, wanted]) => got !== wanted);
  if (wrong.length > 0) {
    fail(`The manifest inside the ${kind} package is not the one it was made from:\n${wrong.map(([what, got, wanted]) => `  ${what}: ${got} (wanted ${wanted})`).join('\n')}`);
  }

  // Only now is it a package: one that passed every check.
  renameSync(partial, file);
  partial = null;
  made.push(file);
  return { kind, file, entries, read, index, family: packageFamilyName(read.name, read.publisher) };
}

const results = packages.map(pack);

/** The report line on the resource index, from what the package holds and, if it was given one, where that came from. */
function indexLine({ entries, index }) {
  if (!entries.includes(RESOURCE_INDEX)) return `Resource index: none, there is no ${RESOURCE_INDEX} in it`;
  if (!index) return `Resource index: ${RESOURCE_INDEX} is in it`;
  const source = index.variable ? `${index.file}, named by ${index.variable}` : index.file;
  return `Resource index: ${RESOURCE_INDEX} is in it, a copy of ${source} (${index.bytes.length} bytes, SHA-256 ${createHash('sha256').update(index.bytes).digest('hex')})`;
}

const withoutIndex = results.filter(({ entries }) => !entries.includes(RESOURCE_INDEX));

console.log(
  [
    ...results.flatMap(({ kind, file, entries, read, index, family }) => [
      '',
      `Package: ${file}`,
      `For: ${PURPOSE[kind]}`,
      `Size: ${statSync(file).size} bytes`,
      `SHA-256: ${createHash('sha256').update(readFileSync(file)).digest('hex')}`,
      `Files in the package: ${entries.length}, of which ${assetImages().length} are images in Assets`,
      indexLine({ entries, index }),
      'Identity in the manifest inside it:',
      `  Name: ${read.name}`,
      `  Publisher: ${read.publisher}`,
      `  Publisher display name: ${read.publisherDisplayName}`,
      `  Version: ${read.version}`,
      `  Package family name: ${family}`,
      entries.includes('AppxSignature.p7x') ? SIGNED[kind] : UNSIGNED[kind],
    ]),
    '',
    `App exe in ${results.length === 1 ? 'it' : 'both'}: version ${built}, built ${statSync(exe).mtime.toISOString()}, SHA-256 ${createHash('sha256').update(exeBytes).digest('hex')}`,
    ...(withoutIndex.length > 0 ? ['', noIndexNote(withoutIndex, stage)] : []),
  ].join('\n'),
);
