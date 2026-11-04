// @vitest-environment node
// Runs scripts/package-msix.mjs for real, as `pnpm package:msix --identity both` does, in a temporary folder: with a stand-in for the
// Windows exe in place of a build, and the packages written to that folder too, so nothing of a real build, and nothing in
// ~/msix-build, is touched. Then it reads the two packages back: which images each holds, at what size, and that both hold the same
// ones. A second suite runs a copy of the script in a copy of the repo, to put a resources.pri at packaging/msix/<package>/ and take it
// away again without touching the real repo, and reads back whether each package got the one made for it. It needs what the script
// needs, a Mac with sips, unzip and makemsix, so it is skipped on every other machine, the Windows CI runner included. The parts that
// need no tool are tested in msix-manifest.test.ts.
import { spawnSync } from 'node:child_process';
import { copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { EXECUTABLE, assetImages, lackingAssets, msixFileName, pngInfo } from './msix-manifest.mjs';

const root = resolve(import.meta.dirname, '..');
const UNZIP = '/usr/bin/unzip';
// Where package-msix.mjs looks for makemsix.
const makemsix = resolve(process.env.ZWT_MAKEMSIX || join(homedir(), 'msix-packaging', '.vs', 'bin', 'makemsix'));
const canPack = process.platform === 'darwin' && ['/usr/bin/sips', UNZIP, makemsix].every((tool) => existsSync(tool));
const kinds = ['store', 'test'] as const;
type Kind = (typeof kinds)[number];

/** What src-tauri/tauri.conf.json says the app is called and which version it is, which is what the packages are named and numbered from. */
function readConf(): { productName: string; version: string } {
  const conf: unknown = JSON.parse(readFileSync(join(root, 'src-tauri', 'tauri.conf.json'), 'utf8'));
  if (typeof conf === 'object' && conf !== null && 'productName' in conf && typeof conf.productName === 'string' && 'version' in conf && typeof conf.version === 'string') {
    return { productName: conf.productName, version: conf.version };
  }
  throw new Error('src-tauri/tauri.conf.json needs a productName and a version');
}

/** The file names inside a package, as `unzip -Z1` lists them. */
function entriesIn(file: string): string[] {
  const listing = spawnSync(UNZIP, ['-Z1', file], { encoding: 'utf8', maxBuffer: 1 << 26 });
  expect(listing.status, listing.stderr).toBe(0);
  return listing.stdout.split('\n').filter(Boolean);
}

/** One file of a package, byte for byte, as `unzip -p` prints it. */
function bytesIn(file: string, entry: string): Buffer {
  const run = spawnSync(UNZIP, ['-p', file, entry], { maxBuffer: 1 << 26 });
  expect(run.status, String(run.stderr)).toBe(0);
  return run.stdout;
}

/**
 * Stand-ins for the app, in the folder the script looks in: it wants an exe that says which version it is, as the version resource of the
 * Tauri build does, and the loader beside it. Neither is run, only packed.
 */
function writeStandIns(release: string, version: string): void {
  mkdirSync(release, { recursive: true });
  const versionEntry = Buffer.concat([Buffer.from('ProductVersion\0', 'utf16le'), Buffer.from(`${version}\0`, 'utf16le')]);
  writeFileSync(join(release, EXECUTABLE), Buffer.concat([Buffer.alloc(64, 0xff), versionEntry, Buffer.alloc(32, 0xff)]));
  writeFileSync(join(release, 'WebView2Loader.dll'), 'stand-in');
}

describe.skipIf(!canPack)('the packages the script makes', () => {
  const { productName, version } = readConf();
  // Made in beforeAll and not here: a skipped suite still runs this function, but not its hooks, and would leave the folder behind.
  let work = '';
  const fileOf = (kind: Kind): string => join(work, 'out', msixFileName(productName, version, kind));
  const entriesOf = (kind: Kind): string[] => entriesIn(fileOf(kind));

  beforeAll(() => {
    work = mkdtempSync(join(tmpdir(), 'zwt-package-msix-'));
    writeStandIns(join(work, 'target', 'x86_64-pc-windows-gnu', 'release'), version);
    const run = spawnSync(process.execPath, [join(root, 'scripts', 'package-msix.mjs'), '--identity', 'both'], {
      cwd: root,
      encoding: 'utf8',
      // The two variables blank, so that none left in the shell of whoever runs this names a resources.pri for it.
      env: { ...process.env, ZWT_MSIX_PRI_STORE: '', ZWT_MSIX_PRI_TEST: '', CARGO_TARGET_DIR: join(work, 'target'), ZWT_MSIX_OUT_DIR: join(work, 'out') },
      timeout: 100_000,
    });
    expect(run.status, `${run.stdout}${run.stderr}${run.error?.message ?? ''}`).toBe(0);
  }, 120_000);

  afterAll(() => {
    if (work) rmSync(work, { recursive: true, force: true });
  });

  it.each(kinds)('puts every image of the list in the %s package, and no other file in Assets', (kind) => {
    const entries = entriesOf(kind);
    expect(lackingAssets(entries)).toEqual([]);
    expect(entries.filter((entry) => entry.startsWith('Assets/')).sort()).toEqual(assetImages().map(({ name }) => name).sort());
  });

  it('puts the same files in both packages, the same images among them, but for a resources.pri, which each has of its own or not at all', () => {
    // A resources.pri is made for one identity, so the repo can hold one for the Store package and none for the test package.
    const withoutIndex = (entries: string[]): string[] => entries.filter((entry) => entry !== 'resources.pri').sort();
    const store = withoutIndex(entriesOf('store'));
    expect(store).toEqual(withoutIndex(entriesOf('test')));
    expect(store.filter((entry) => entry.startsWith('Assets/'))).toHaveLength(assetImages().length);
  });

  it.each(kinds)('cuts each image of the %s package at the size its name asks for, and keeps it able to be transparent', (kind) => {
    const unpacked = join(work, `unpacked-${kind}`);
    const run = spawnSync(UNZIP, ['-q', '-o', fileOf(kind), 'Assets/*', '-d', unpacked], { encoding: 'utf8' });
    expect(run.status, run.stderr).toBe(0);
    for (const { name, size } of assetImages()) {
      expect(pngInfo(readFileSync(join(unpacked, name))), name).toEqual({ width: size, height: size, alpha: true });
    }
    // Unzips and reads 60 images: it took 8 s on a busy machine, past the default 5 s.
  }, 30_000);
});

describe.skipIf(!canPack)('the resources.pri of a package, in a copy of the repo', () => {
  const VERSION = '1.3.3';
  const PRODUCT = 'zWorkTracker';
  const NAMES = { store: 'PedroMiguelRodriguesJorge.zWorkTracker', test: 'rustcircle.zWorkTracker.Test' } as const;
  type Indexes = Partial<Record<Kind, Buffer>>;
  let work = '';
  let repo = '';
  const out = (): string => join(work, 'out');
  const fileOf = (kind: Kind): string => join(out(), msixFileName(PRODUCT, VERSION, kind));
  const usual = (kind: Kind): string => join('packaging', 'msix', kind, 'resources.pri');

  /** The path of every image as makepri writes it into an index: 8-bit text with a backslash, as Microsoft's own two indexes hold theirs. */
  const imagePaths = assetImages().map(({ name }) => name.replace('/', '\\'));

  /**
   * Something shaped like what makepri writes, as read off Microsoft's own resources.pri: the magic first and last, the name of the
   * resource map as UTF-16LE, as ms-appx://<name>/ and on its own, and the path of each of `images` (all 60 by default). `extra` tells two
   * indexes of one package apart.
   */
  function pri(name: string, extra = '', images: readonly string[] = imagePaths): Buffer {
    const utf16 = (text: string) => Buffer.from(text, 'utf16le');
    return Buffer.concat([
      Buffer.from('mrm_pri2'),
      Buffer.alloc(24),
      Buffer.from('[mrm_hschemaex] '),
      utf16(`ms-appx://${name}/`),
      utf16(name),
      Buffer.from('[mrm_dataitem] '),
      ...images.flatMap((path) => [Buffer.from(path, 'latin1'), Buffer.alloc(1)]),
      Buffer.from(extra),
      Buffer.from('mrm_pri2'),
    ]);
  }

  /**
   * Runs the copy of the script, after emptying packaging/ of the copy and putting `indexes` where the script looks for them. `env` is added
   * to the environment, in which the two variables are blank otherwise. The packages are written to the same folder every time, and each
   * run takes away those of the one before.
   */
  function run(indexes: Indexes, env: Record<string, string> = {}): { status: number | null; said: string } {
    rmSync(join(repo, 'packaging'), { recursive: true, force: true });
    for (const kind of kinds) {
      const bytes = indexes[kind];
      if (!bytes) continue;
      mkdirSync(join(repo, dirname(usual(kind))), { recursive: true });
      writeFileSync(join(repo, usual(kind)), bytes);
    }
    const done = spawnSync(process.execPath, [join(repo, 'scripts', 'package-msix.mjs'), '--identity', 'both'], {
      cwd: repo,
      encoding: 'utf8',
      env: { ...process.env, ZWT_MSIX_PRI_STORE: '', ZWT_MSIX_PRI_TEST: '', CARGO_TARGET_DIR: join(work, 'target'), ZWT_MSIX_OUT_DIR: out(), ...env },
      timeout: 100_000,
    });
    return { status: done.status, said: `${done.stdout}${done.stderr}${done.error?.message ?? ''}` };
  }

  beforeAll(() => {
    // Real, so that the path the script reports for its repo is the one this builds: on a Mac the temp folder is a link.
    work = realpathSync(mkdtempSync(join(tmpdir(), 'zwt-package-msix-pri-')));
    repo = join(work, 'repo');
    // What the script reads from its repo, and no more: itself and the modules it imports, a config with one license to ship, and the
    // app icon the images are cut from. The real repo is not touched, and whatever packaging/ it holds does not matter here.
    cpSync(join(root, 'scripts'), join(repo, 'scripts'), { recursive: true, filter: (source) => statSync(source).isDirectory() || source.endsWith('.mjs') });
    mkdirSync(join(repo, 'src-tauri', 'icons'), { recursive: true });
    copyFileSync(join(root, 'src-tauri', 'icons', 'icon.png'), join(repo, 'src-tauri', 'icons', 'icon.png'));
    const conf = { productName: PRODUCT, version: VERSION, bundle: { shortDescription: 'Labor hours tracker', resources: { '../LICENSE': 'licenses/LICENSE' } } };
    writeFileSync(join(repo, 'src-tauri', 'tauri.conf.json'), JSON.stringify(conf));
    writeFileSync(join(repo, 'LICENSE'), 'a license');
    writeStandIns(join(work, 'target', 'x86_64-pc-windows-gnu', 'release'), VERSION);
  });

  afterAll(() => {
    if (work) rmSync(work, { recursive: true, force: true });
  });

  it('puts the resources.pri of each package at the root of that package, whole, and says where it came from', () => {
    // The Store package's is at the usual place. The test package's is named by a variable, which wins over a file at its usual place.
    const store = pri(NAMES.store);
    const decoy = pri(NAMES.test, ' decoy at the usual place');
    const fromVariable = pri(NAMES.test, ' named by the variable');
    const named = join(work, 'made-on-windows.pri');
    writeFileSync(named, fromVariable);
    const { status, said } = run({ store, test: decoy }, { ZWT_MSIX_PRI_TEST: named });
    expect(status, said).toBe(0);
    for (const kind of kinds) expect(entriesIn(fileOf(kind)), kind).toContain('resources.pri');
    expect(bytesIn(fileOf('store'), 'resources.pri')).toEqual(store);
    expect(bytesIn(fileOf('test'), 'resources.pri')).toEqual(fromVariable);
    expect(said).toContain(`Resource index: resources.pri is in it, a copy of ${join(repo, usual('store'))} (${store.length} bytes`);
    expect(said).toContain(`Resource index: resources.pri is in it, a copy of ${named}, named by ZWT_MSIX_PRI_TEST (${fromVariable.length} bytes`);
    expect(said).not.toContain('No resources.pri');
  }, 60_000);

  it.each(kinds)('gives the %s package an index of its own, and the other package, packed from the same stage, none', (kind) => {
    const other: Kind = kind === 'store' ? 'test' : 'store';
    const indexes: Indexes = {};
    indexes[kind] = pri(NAMES[kind]);
    const { status, said } = run(indexes);
    expect(status, said).toBe(0);
    expect(entriesIn(fileOf(kind))).toContain('resources.pri');
    expect(entriesIn(fileOf(other))).not.toContain('resources.pri');
    expect(said).toContain('Resource index: none, there is no resources.pri in it');
    expect(said).toContain(`No resources.pri in the ${other} package:`);
    expect(said).not.toContain(`No resources.pri in the ${kind}`);
  }, 60_000);

  it('packs no resources.pri when there is none, and says how to make one on Windows and where to leave it', () => {
    const { status, said } = run({});
    expect(status, said).toBe(0);
    for (const kind of kinds) expect(entriesIn(fileOf(kind)), kind).not.toContain('resources.pri');
    expect(said.split('Resource index: none, there is no resources.pri in it')).toHaveLength(3);
    expect(said).toContain('No resources.pri in the store and test packages');
    expect(said).toContain('makepri, which can, is a Windows program');
    expect(said).toContain('`pnpm msix:pri` makes both and saves them where step 5 below says');
    expect(said).not.toContain('runs only on Windows');
    expect(said).toContain('makepri createconfig /cf priconfig.xml /dq en-US /o /pv 10.0.0');
    expect(said).toContain('Delete the <packaging> element from priconfig.xml');
    expect(said).toContain('makepri new /cf priconfig.xml /pr <stage> /mn <stage>\\AppxManifest.xml /of <stage>\\resources.pri /o');
    for (const [kind, variable] of [['store', 'ZWT_MSIX_PRI_STORE'], ['test', 'ZWT_MSIX_PRI_TEST']] as const) {
      expect(said).toContain(`${kind}: packaging/msix/${kind}/resources.pri (or the file named in ${variable})`);
    }
    expect(said).toContain('not on the version');
  }, 60_000);

  it('refuses the index of the other package, in either place, and leaves none of the packages of the run before', () => {
    // A good run first, so that there are packages in the folder for the failing run to take away: none of those may be taken for this one's.
    const first = run({ store: pri(NAMES.store), test: pri(NAMES.test) });
    expect(first.status, first.said).toBe(0);
    expect(existsSync(fileOf('store')) && existsSync(fileOf('test'))).toBe(true);
    const { status, said } = run({ store: pri(NAMES.test), test: pri(NAMES.store) });
    expect(status, said).toBe(1);
    expect(said).toContain(`${join(repo, usual('store'))} cannot be the resource index of the store package: it names the identity of the test package`);
    expect(said).toContain(`${join(repo, usual('test'))} cannot be the resource index of the test package: it names the identity of the store package`);
    expect(existsSync(fileOf('store')) || existsSync(fileOf('test'))).toBe(false);
  }, 60_000);

  it('refuses an index made for fewer images than the package has, which is what one left from before the set changed is, and leaves no package', () => {
    // A good run first, so that there are packages for the failing run to take away.
    const first = run({ store: pri(NAMES.store), test: pri(NAMES.test) });
    expect(first.status, first.said).toBe(0);
    const stale = run({ store: pri(NAMES.store, '', imagePaths.slice(0, 3)), test: pri(NAMES.test, '', imagePaths.filter((path) => !path.includes('altform-unplated'))) });
    expect(stale.status, stale.said).toBe(1);
    expect(stale.said).toContain(`${join(repo, usual('store'))} cannot be the resource index of the store package: it does not list 57 of the 60 images of a package`);
    expect(stale.said).toContain(`${join(repo, usual('test'))} cannot be the resource index of the test package: it does not list 14 of the 60 images of a package`);
    expect(stale.said).toContain('Make it again with pnpm msix:pri');
    expect(existsSync(fileOf('store')) || existsSync(fileOf('test'))).toBe(false);
  }, 60_000);

  it('refuses a file that is not a PRI file, and a variable that names a file that is not there', () => {
    const notPri = run({ store: Buffer.from('<?xml version="1.0"?><resources/>') });
    expect(notPri.status, notPri.said).toBe(1);
    expect(notPri.said).toContain('it is not a PRI file');
    const gone = join(work, 'gone.pri');
    const missing = run({}, { ZWT_MSIX_PRI_STORE: gone });
    expect(missing.status, missing.said).toBe(1);
    expect(missing.said).toContain(`ZWT_MSIX_PRI_STORE names ${gone}, which is not there.`);
    expect(existsSync(fileOf('store')) || existsSync(fileOf('test'))).toBe(false);
  }, 60_000);
});
