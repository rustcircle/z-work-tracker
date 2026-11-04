#!/usr/bin/env node
// Makes the two resources.pri of the MSIX packages, the Store's and the test one, from this Mac with the help of a Windows VM (UTM). Windows
// finds the target-size and unplated images, which draw the logo without a plate in the taskbar and Start, only through that index, and
// makepri, which makes it, runs only on Windows. One run:
//   1. cuts the 60 images from the app icon and writes the AppxManifest.xml of each package into store/ and test/ in a build folder, with the
//      same functions package-msix.mjs stages with (msix-stage.mjs, msix-manifest.mjs);
//   2. gets makepri.exe for Windows on ARM and on x64 from Microsoft.Windows.SDK.BuildTools on nuget.org, checks the package's signature with
//      `dotnet nuget verify --all`, and keeps both exes in ~/msix-build/tools (never run on this Mac) with the package's SHA-256;
//   3. writes d.ps1, a Windows PowerShell 5.1 script that fetches those files into C:\zwt-test on the VM, runs makepri on them and sends each
//      resources.pri back, and serves it all for a few minutes on the Mac's address on the UTM shared network (192.168.64.1). The makepri it runs
//      is the x64 one on every PC (Windows 11 on ARM runs it by emulation; a resources.pri does not depend on the processor, and the packages are
//      x64); the ARM64 one is fetched, and used, only if the x64 one does not start;
//   4. checks what the VM sent as package-msix.mjs will (the identity of each package, every image listed) and saves it to
//      packaging/msix/<package>/resources.pri.
// The only thing typed in the VM is one short line, printed here. --dry-run does all of it but the VM: it serves on 127.0.0.1, asks its own
// server the questions the VM would, sends it made-up indexes, and installs them in the build folder instead of packaging/.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, createWriteStream, existsSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, request as httpRequest } from 'node:http';
import { createServer as createProbe, isIPv4 } from 'node:net';
import { homedir, networkInterfaces, tmpdir } from 'node:os';
import { basename, dirname, join, posix, resolve } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import {
  PACKAGES,
  RESOURCE_INDEX,
  assetImages,
  checkIndexImages,
  checkResourceIndex,
  identityOf,
  indexPathOf,
  manifestFor,
  msixVersion,
  resourceIndexFor,
} from './msix-manifest.mjs';
import { SIPS, cargoTargetRoot, cutAssetImages, readAppConf } from './msix-stage.mjs';

/** The Mac's address on the UTM shared network, where a VM that uses it finds the Mac. It exists only while such a VM is running. */
export const DEFAULT_HOST = '192.168.64.1';
export const DEFAULT_PORT = 8765;
export const DEFAULT_TIMEOUT_MINUTES = 15;
/** The most a PUT may carry. The indexes are a few kilobytes. */
export const UPLOAD_LIMIT = 2 * 1024 * 1024;
/**
 * How long the server keeps a connection that has nothing to do open, in milliseconds. Windows PowerShell 5.1 reuses a connection for up to 100
 * seconds, and the upload comes after makepri has run for some seconds: a server that hangs up after Node's 5 would be sent a request on a
 * connection it has just closed. Longer than the 100 seconds, the client is the one that lets go.
 */
export const KEEP_ALIVE_MS = 120_000;
/** The only folder the script on the VM writes in. */
export const VM_DIRECTORY = 'C:\\zwt-test';
/** The script the VM fetches, at a fixed name so that what is typed in the VM never changes. */
export const SCRIPT_PATH = '/d.ps1';
/** Where each package's index is PUT. These two names are the only ones this script's server accepts a PUT for. */
export const UPLOAD_PATHS = Object.freeze({ store: '/store-resources.pri', test: '/test-resources.pri' });
/** Where the VM asks what the Mac holds already (and, for pnpm msix:vm, how the rest of the job stands): a small JSON, built when it is asked. */
export const STATUS_PATH = '/status';
/** Where the VM fetches makepri.exe from: the x64 one on every PC, and the arm64 one only if the x64 one does not start (the PC's architecture is not asked). */
export const TOOL_PATHS = Object.freeze({ arm64: '/makepri-arm64.exe', x64: '/makepri-x64.exe' });
export const PACKAGE_ID = 'Microsoft.Windows.SDK.BuildTools';
/** The versions nuget.org holds of the package: the flat container's index. */
export const VERSIONS_URL = `https://api.nuget.org/v3-flatcontainer/${PACKAGE_ID.toLowerCase()}/index.json`;
const CACHE_FILE = 'cache.json';
const KINDS = Object.freeze(Object.keys(PACKAGES));
const ARCHITECTURES = Object.freeze(['arm64', 'x64']);
export const SHA256 = /^[0-9a-f]{64}$/;
const UNZIP = '/usr/bin/unzip';
const NETWORK_HINT =
  "The UTM VM's shared network puts the Mac at 192.168.64.1, and only while the VM is running: start the UTM VM (its network set to Shared Network), then run this again.";

/** An expected failure: what went wrong, said once, with no stack. */
export class Failure extends Error {}

// ---------------------------------------------------------------------------------------------------------------------------------------
// The command line

const OPTIONS_HELP = [
  ['--dry-run', 'Do everything but wait for the VM: serve on 127.0.0.1 on any free port, ask the server what the VM would, send it made-up indexes, and install them in the build folder, not packaging/.'],
  ['--host <address>', `The address to serve on, an IPv4 address of this Mac (default ${DEFAULT_HOST}). Not 0.0.0.0: the files are for one VM, not for every network.`],
  ['--port <number>', `The port to serve on (default ${DEFAULT_PORT}). The line to type in the VM names it.`],
  ['--timeout <minutes>', `Stop waiting for the VM after this long (default ${DEFAULT_TIMEOUT_MINUTES}).`],
  ['--out-dir <folder>', "Where the folders for the VM are put (default: msix-pri in Cargo's target folder, so CARGO_TARGET_DIR is followed)."],
  ['--tools-dir <folder>', 'Where makepri is kept, one folder per SDK version (default ~/msix-build/tools/sdk-buildtools).'],
  ['--sdk-version <version>', `Use this version of ${PACKAGE_ID} (such as 10.0.28000.2957) instead of the latest stable one.`],
  ['--dotnet <path>', 'The dotnet that verifies the package (default: ZWT_DOTNET, then dotnet on the PATH, then /run/current-system/sw/bin/dotnet).'],
  ['-h, --help', 'Show this text.'],
];

/** The text of --help: what the script does and each option. */
export function helpText() {
  const width = Math.max(...OPTIONS_HELP.map(([flag]) => flag.length));
  return [
    'Usage: pnpm msix:pri [options]     (node scripts/make-pri.mjs [options])',
    '',
    'Makes packaging/msix/store/resources.pri and packaging/msix/test/resources.pri with makepri on a Windows VM, so that the taskbar and Start',
    'draw the logo without a plate. It prints one line to type in PowerShell in the VM, waits for both files, checks them and saves them.',
    '',
    'Options:',
    ...OPTIONS_HELP.map(([flag, text]) => `  ${flag.padEnd(width)}  ${text}`),
    '',
    'Then run: pnpm package:msix --identity both',
  ].join('\n');
}

/**
 * The command line, as `{ help, dryRun, host, port, timeoutMinutes, outDir, toolsDir, sdkVersion, dotnet }`; the last four are null when not given.
 * `--name value` and `--name=value` both work. A misspelt option, a value that cannot be used, or one given twice throws a Failure that says
 * so, instead of being taken for a default. `extra` lets another script (msix-vm.mjs) share this: `timeoutMinutes` is the default wait, and
 * `paths` maps more options that take a folder to the key they are returned under (null when not given).
 */
export function parseOptions(argv, extra = {}) {
  const paths = { '--out-dir': 'outDir', '--tools-dir': 'toolsDir', '--dotnet': 'dotnet', ...extra.paths };
  const options = { help: false, dryRun: false, host: DEFAULT_HOST, port: DEFAULT_PORT, timeoutMinutes: extra.timeoutMinutes ?? DEFAULT_TIMEOUT_MINUTES, outDir: null, toolsDir: null, sdkVersion: null, dotnet: null };
  for (const key of Object.values(extra.paths ?? {})) options[key] = null;
  const unknown = [];
  const problems = [];
  const seen = new Set();
  const withValue = new Set(['--host', '--port', '--timeout', '--sdk-version', ...Object.keys(paths)]);
  for (let at = 0; at < argv.length; at++) {
    const arg = argv[at];
    if (arg === '--help' || arg === '-h') {
      options.help = true;
    } else if (arg === '--dry-run') {
      options.dryRun = true;
    } else {
      const equals = arg.startsWith('--') ? arg.indexOf('=') : -1;
      const name = equals > 0 ? arg.slice(0, equals) : arg;
      if (!withValue.has(name)) {
        unknown.push(arg);
        continue;
      }
      const value = equals > 0 ? arg.slice(equals + 1) : argv[++at];
      if (value === undefined) {
        problems.push(`${name} needs a value.`);
        continue;
      }
      if (seen.has(name)) {
        problems.push(`${name} was given more than once.`);
        continue;
      }
      seen.add(name);
      const bad = setOption(options, name, value, paths);
      if (bad) problems.push(bad);
    }
  }
  if (options.help) return options;
  if (unknown.length > 0) problems.unshift(`Unknown argument: ${unknown.join(' ')}. See --help for the options.`);
  if (problems.length > 0) throw new Failure(problems.join('\n'));
  return options;
}

/** Puts the value of one option in `options`, or returns what is wrong with it. `paths` maps the options that name a folder or program to their keys. */
function setOption(options, name, value, paths) {
  const shown = JSON.stringify(value);
  switch (name) {
    case '--host':
      if (!isIPv4(value)) return `--host must be an IPv4 address of this Mac, such as ${DEFAULT_HOST} (got ${shown}). The line typed in the VM has no room for a name.`;
      if (value === '0.0.0.0') return '--host 0.0.0.0 would serve on every network of this Mac. Name the one address the VM reaches the Mac on.';
      options.host = value;
      return null;
    case '--port': {
      const port = /^\d{1,5}$/.test(value) ? Number(value) : 0;
      if (port < 1 || port > 65535) return `--port must be a whole number from 1 to 65535 (got ${shown}).`;
      options.port = port;
      return null;
    }
    case '--timeout': {
      const minutes = /^\d+(\.\d+)?$/.test(value) ? Number(value) : 0;
      if (!(minutes > 0 && minutes <= 24 * 60)) return `--timeout must be a number of minutes above 0 and at most 1440 (got ${shown}).`;
      options.timeoutMinutes = minutes;
      return null;
    }
    case '--sdk-version':
      if (!/^\d+(\.\d+){2,3}$/.test(value)) return `--sdk-version must be a release version such as 10.0.28000.2957, not a prerelease (got ${shown}).`;
      options.sdkVersion = value;
      return null;
    default: {
      if (value.trim() === '') return `${name} needs a path (got ${shown}).`;
      options[paths[name]] = value;
      return null;
    }
  }
}

/** The one line to type in PowerShell in the VM. It is short and does not change, because the VM's keyboard is Portuguese and nothing can be pasted into it. */
export function vmLine(host, port) {
  return `iwr ${host}:${port}${SCRIPT_PATH} -UseBasicParsing | iex`;
}

/** Whether `host` is one of the addresses of this Mac. `interfaces` is what os.networkInterfaces() returns. */
export function addressIsUp(host, interfaces = networkInterfaces()) {
  return Object.values(interfaces).some((list) => (list ?? []).some((entry) => entry.address === host));
}

/** What is wrong when listening on `host`:`port` failed with `error`, in words for the person at the keyboard. */
export function listenProblem(error, host, port) {
  switch (error?.code) {
    case 'EADDRINUSE':
      return `Port ${port} on ${host} is already in use by another program. Stop that program, or pick another port with --port: the line to type in the VM then names it.`;
    case 'EADDRNOTAVAIL':
      return `${host} is not an address of this Mac. ${NETWORK_HINT}`;
    case 'EACCES':
      return `This user may not listen on port ${port}. Pick a port above 1023 with --port.`;
    default:
      return `Could not listen on ${host}:${port}: ${error?.message ?? error}`;
  }
}

/** Checks, before any work is done, that the server can be started: the address is the Mac's and the port is free. Throws a Failure that says which. Nothing is stopped or killed to make room. */
export async function checkCanListen(host, port) {
  if (!addressIsUp(host)) throw new Failure(`${host} is not an address of this Mac. ${NETWORK_HINT}`);
  await new Promise((resolveProbe, rejectProbe) => {
    const probe = createProbe();
    probe.once('error', (error) => rejectProbe(new Failure(listenProblem(error, host, port))));
    probe.listen({ host, port, exclusive: true }, () => probe.close(() => resolveProbe()));
  });
}

// ---------------------------------------------------------------------------------------------------------------------------------------
// makepri.exe from nuget.org

/** `a.b.c` or `a.b.c.d`, no prerelease label: what nuget.org calls a stable version of this package. */
const RELEASE = /^\d+(\.\d+){2,3}$/;

/** Compares two release versions part by part, as numbers: 10.0.9 is before 10.0.10, which a text comparison gets wrong. Negative, 0 or positive. */
export function compareVersions(a, b) {
  const [x, y] = [a, b].map((version) => version.split('.').map(Number));
  for (let at = 0; at < Math.max(x.length, y.length); at++) {
    const difference = (x[at] ?? 0) - (y[at] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

/** The newest release in `versions`, the list nuget.org gives. A version with a label (-preview, -rtm) is a prerelease and never taken. */
export function latestStable(versions) {
  const releases = versions.filter((version) => typeof version === 'string' && RELEASE.test(version));
  if (releases.length === 0) throw new Failure(`nuget.org lists no release version of ${PACKAGE_ID}.`);
  return releases.reduce((best, version) => (compareVersions(version, best) > 0 ? version : best));
}

/** The address nuget.org serves a version of the package from; it redirects to its CDN. */
export function packageUrl(version) {
  return `https://www.nuget.org/api/v2/package/${PACKAGE_ID}/${version}`;
}

/** Whether `text` is an https address on nuget.org or one of its subdomains (api, globalcdn), with no user name in it. The only places anything is fetched from. */
export function isNugetUrl(text) {
  let url;
  try {
    url = new URL(text);
  } catch {
    return false;
  }
  return url.protocol === 'https:' && (url.hostname === 'nuget.org' || url.hostname.endsWith('.nuget.org')) && url.username === '' && url.password === '';
}

/**
 * GET `start` from nuget.org, following its redirects by hand so that every address on the way is checked to be on nuget.org before it is
 * asked. Returns `{ response, url }` for the first answer that is 200; anything else, a redirect elsewhere or a loop included, throws.
 */
export async function fetchFromNuget(start, { signal, fetchImpl = fetch } = {}) {
  let url = start;
  for (let hops = 0; hops < 6; hops++) {
    if (!isNugetUrl(url)) throw new Failure(`Not fetching ${url}: only nuget.org is fetched from.`);
    const response = await fetchImpl(url, { redirect: 'manual', signal, headers: { 'user-agent': 'zWorkTracker make-pri.mjs' } });
    if (response.status >= 300 && response.status < 400) {
      const next = response.headers.get('location');
      await response.body?.cancel();
      if (!next) throw new Failure(`${url} answered ${response.status} with nowhere to go.`);
      url = new URL(next, url).href;
      continue;
    }
    if (response.status !== 200) {
      await response.body?.cancel();
      throw new Failure(`${url} answered HTTP ${response.status}.`);
    }
    return { response, url };
  }
  throw new Failure(`${start} redirected too many times.`);
}

/** Downloads `url` (nuget.org only) to `file`, through a `.partial` file that is renamed once it is whole. Returns its size in bytes and SHA-256. */
export async function downloadFile(url, file, { signal, fetchImpl, maxBytes = 512 * 1024 * 1024, onProgress } = {}) {
  const { response } = await fetchFromNuget(url, { signal, fetchImpl });
  if (!response.body) throw new Failure(`${url} sent no body.`);
  const declared = Number(response.headers.get('content-length') ?? NaN);
  const hash = createHash('sha256');
  let bytes = 0;
  const partial = `${file}.partial`;
  const count = new Transform({
    transform(chunk, _encoding, done) {
      bytes += chunk.length;
      if (bytes > maxBytes) return done(new Failure(`${url} is larger than ${maxBytes} bytes. Not taking it.`));
      hash.update(chunk);
      onProgress?.(bytes, declared);
      return done(null, chunk);
    },
  });
  try {
    await pipeline(Readable.fromWeb(response.body), count, createWriteStream(partial), { signal });
    // The length is of what went over the wire: with a Content-Encoding, fetch has unpacked it and the two differ.
    if (Number.isFinite(declared) && !response.headers.get('content-encoding') && declared !== bytes) throw new Failure(`${url} promised ${declared} bytes and sent ${bytes}.`);
  } catch (error) {
    rmSync(partial, { force: true });
    throw error;
  }
  renameSync(partial, file);
  return { bytes, sha256: hash.digest('hex') };
}

/** The machine a Windows exe is for, from its PE header: 'x64', 'arm64', 'arm64ec', 'x86', another one's number as 0x..., or null if it is not a PE file. */
export function peMachine(bytes) {
  if (bytes.length < 0x40 || bytes.readUInt16LE(0) !== 0x5a4d) return null;
  const at = bytes.readUInt32LE(0x3c);
  if (at + 6 > bytes.length || bytes.readUInt32LE(at) !== 0x00004550) return null;
  const machine = bytes.readUInt16LE(at + 4);
  return { 0x8664: 'x64', 0xaa64: 'arm64', 0xa641: 'arm64ec', 0x14c: 'x86' }[machine] ?? `0x${machine.toString(16)}`;
}

/**
 * Finds the two makepri.exe in the file list of the package, `entries` as `unzip -Z1` prints them: bin/<sdk version>/arm64/makepri.exe and
 * bin/<sdk version>/x64/makepri.exe, for the newest SDK version that has both. Returns `{ sdk, arm64, x64 }`, the last two being the names to
 * extract. Only names of exactly that shape count, so nothing with `..` or a drive in it is ever a candidate.
 */
export function findMakepriMembers(entries) {
  const found = new Map();
  for (const entry of entries) {
    const match = /^bin\/(\d+\.\d+\.\d+\.\d+)\/(arm64|x64)\/makepri\.exe$/.exec(entry);
    if (!match || posix.normalize(entry) !== entry) continue;
    const [, sdk, arch] = match;
    found.set(sdk, { ...found.get(sdk), [arch]: entry });
  }
  const complete = [...found].filter(([, members]) => members.arm64 && members.x64).sort(([a], [b]) => compareVersions(b, a));
  const [best] = complete;
  if (!best) throw new Failure(`The package has no bin/<sdk version>/arm64/makepri.exe and x64/makepri.exe. Found: ${[...found.keys()].join(', ') || 'no makepri.exe at all'}.`);
  return { sdk: best[0], arm64: best[1].arm64, x64: best[1].x64 };
}

function sha256Of(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

/** A file name that is a name and not a path, as the cache record may hold: no separator, not `..`. */
function plainName(name) {
  return typeof name === 'string' && name !== '' && name !== '.' && name !== '..' && basename(name) === name && !name.includes('\\');
}

/** What is wrong with a cache record read from disk for `version`, or null. The file is data, so its shape is checked, not assumed. */
function recordProblem(record, version) {
  const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
  if (!object(record) || record.schema !== 1) return 'cache.json is not one this script wrote';
  if (record.version !== version) return `cache.json is for ${String(record.version)}, not ${version}`;
  const files = [['nupkg', record.nupkg]];
  for (const arch of ARCHITECTURES) files.push([`makepri ${arch}`, object(record.makepri) ? record.makepri[arch] : undefined]);
  for (const [what, entry] of files) {
    if (!object(entry) || !plainName(entry.file) || !SHA256.test(String(entry.sha256))) return `cache.json has no usable record of the ${what}`;
  }
  if (!object(record.verified) || typeof record.verified.line !== 'string') return 'cache.json does not say the package was verified';
  return null;
}

/**
 * Looks in `dir`, the folder of one SDK version, for makepri kept by an earlier run: `{ record }` if cache.json is for `version` and the
 * package and both exes are there and hash to what it records, otherwise `{ reason }`. Nothing is trusted from the folder but those hashes.
 */
export function readToolCache(dir, version) {
  let record;
  try {
    record = JSON.parse(readFileSync(join(dir, CACHE_FILE), 'utf8'));
  } catch (error) {
    return { reason: error?.code === 'ENOENT' ? 'there is no cache.json yet' : `cache.json cannot be read: ${error?.message}` };
  }
  const bad = recordProblem(record, version);
  if (bad) return { reason: bad };
  for (const entry of [record.nupkg, ...ARCHITECTURES.map((arch) => record.makepri[arch])]) {
    let bytes;
    try {
      bytes = readFileSync(join(dir, entry.file));
    } catch {
      return { reason: `${entry.file} is missing` };
    }
    if (sha256Of(bytes) !== entry.sha256) return { reason: `${entry.file} does not hash to the SHA-256 recorded for it` };
  }
  return { record };
}

/** The dotnet to verify with: the one asked for, ZWT_DOTNET, dotnet on the PATH, or where nix-darwin puts it. The first that answers `--version`. */
function findDotnet(asked, env) {
  const candidates = [asked, env.ZWT_DOTNET, 'dotnet', '/run/current-system/sw/bin/dotnet'].filter(Boolean);
  for (const candidate of candidates) {
    const run = spawnSync(candidate, ['--version'], { encoding: 'utf8', cwd: tmpdir(), timeout: 30_000 });
    if (run.status === 0) return { path: candidate, version: run.stdout.trim() };
  }
  throw new Failure(`dotnet was not found (tried ${candidates.join(', ')}). It verifies the signature of the package that makepri comes in: install the .NET SDK, or name it with --dotnet.`);
}

/**
 * The signatures `dotnet nuget verify --all` lists for a package, from what it printed: `{ type, subject }` for each "Signature type:" and the
 * "Subject Name:" under it. For the real package that is an Author signature by CN=Microsoft Corporation and a Repository one by NuGet.org.
 */
export function signaturesIn(output) {
  const found = [];
  for (const line of output.split(/\r?\n/)) {
    const type = /^\s*Signature type:\s*(\S+)/.exec(line);
    if (type) found.push({ type: type[1], subject: '' });
    const subject = /^\s*Subject Name:\s*(.+?)\s*$/.exec(line);
    const last = found.at(-1);
    if (subject && last && last.subject === '') last.subject = subject[1];
  }
  return found;
}

// The subject of each signer as dotnet prints it for the real package: the common name first and the organisation second, both the name. The
// match starts at the beginning of the subject, so a name that merely contains `O=Microsoft Corporation` somewhere (inside a quoted common
// name, say) is not Microsoft's.
const AUTHOR_SUBJECT = /^CN=Microsoft Corporation, O=Microsoft Corporation(,|$)/;
const REPOSITORY_SUBJECT = /^CN=NuGet\.org Repository by Microsoft, O=NuGet\.org Repository by Microsoft(,|$)/;

/**
 * What is wrong with the signers of the package, or null. dotnet accepting a signature says the package is whole and the signature is
 * trusted, not whose it is, and these exes are run on the VM: so the author must be Microsoft Corporation, and nuget.org must have
 * countersigned it as the repository that served it. Each subject must begin as the real one does (review finding R4).
 */
export function signerProblem(signatures) {
  const subjectOf = (type) => signatures.find((one) => one.type === type)?.subject;
  const author = subjectOf('Author');
  const repository = subjectOf('Repository');
  if (!author || !AUTHOR_SUBJECT.test(author)) return `its author signature is ${author ? `by ${author}` : 'missing'}, and it must be by Microsoft Corporation`;
  if (!repository || !REPOSITORY_SUBJECT.test(repository)) return `its repository signature is ${repository ? `by ${repository}` : 'missing'}, and it must be by NuGet.org Repository by Microsoft`;
  return null;
}

/**
 * Runs `dotnet nuget verify --all` on the package. Its exit status decides: anything but 0 (an unsigned package, one changed since it was
 * signed, a signature that is not trusted) throws what it said. Then the signers are checked (signerProblem). Returns `{ line }`, which says who signed.
 */
function verifyPackage(file, dotnet) {
  const run = spawnSync(dotnet.path, ['nuget', 'verify', '--all', file], {
    encoding: 'utf8',
    // Not in the folder the package is in: dotnet reads global.json and NuGet.config from where it runs.
    cwd: tmpdir(),
    env: { ...process.env, DOTNET_NOLOGO: '1', DOTNET_CLI_TELEMETRY_OPTOUT: '1', DOTNET_SKIP_FIRST_TIME_EXPERIENCE: '1', DOTNET_CLI_UI_LANGUAGE: 'en' },
    timeout: 300_000,
    maxBuffer: 1 << 24,
  });
  const said = `${run.stdout ?? ''}${run.stderr ?? ''}`.trim();
  if (run.error) throw new Failure(`Could not run ${dotnet.path} nuget verify: ${run.error.message}`);
  if (run.status !== 0) throw new Failure(`dotnet nuget verify --all did not accept ${basename(file)} (exit ${run.status}), so its makepri.exe is not used:\n${said}`);
  const signatures = signaturesIn(said);
  const problem = signerProblem(signatures);
  if (problem) throw new Failure(`dotnet nuget verify --all accepted ${basename(file)}, but ${problem}. Its makepri.exe is not used:\n${said}`);
  return { line: `exit 0, ${signatures.map(({ type, subject }) => `${type} signature by ${subject}`).join('; ')}` };
}

/** The names inside a zip file, as `unzip -Z1` lists them. */
function listZip(file) {
  const run = spawnSync(UNZIP, ['-Z1', file], { encoding: 'utf8', maxBuffer: 1 << 26 });
  if (run.error || run.status !== 0) throw new Failure(`${file} cannot be read as a zip file${run.error ? `: ${run.error.message}` : `:\n${run.stderr}`}`);
  return run.stdout.split('\n').filter(Boolean);
}

/** One file out of a zip, as bytes. `member` is a name chosen by findMakepriMembers, so it has no wildcard or `..` in it; `-p` writes to the pipe, never to disk. */
function extractMember(file, member) {
  if (!/^bin\/\d+\.\d+\.\d+\.\d+\/(arm64|x64)\/makepri\.exe$/.test(member)) throw new Failure(`Refusing to extract ${JSON.stringify(member)}.`);
  const run = spawnSync(UNZIP, ['-p', file, member], { maxBuffer: 1 << 28 });
  if (run.error || run.status !== 0 || !Buffer.isBuffer(run.stdout) || run.stdout.length === 0) throw new Failure(`Could not read ${member} out of ${file}.`);
  return run.stdout;
}

/**
 * makepri.exe for both architectures, ready to be served, from `toolsDir/<version>/`. The version is `sdkVersion` or the newest release on
 * nuget.org. If the folder holds a good cache (readToolCache) nothing is fetched; otherwise the package is downloaded from nuget.org,
 * checked with `dotnet nuget verify --all` (a package that fails it is deleted and the run stops), and only bin/<sdk>/arm64/makepri.exe and
 * bin/<sdk>/x64/makepri.exe are read out of it, as bytes, their PE machine checked. Nothing from the package is ever run here.
 * Returns `{ version, dir, reused, record, tools: { arm64: { file, bytes, sha256 }, x64 } }`.
 */
export async function ensureMakepri({ toolsDir, sdkVersion = null, dotnet = null, env = process.env, say = () => {}, signal, fetchImpl } = {}) {
  let version = sdkVersion;
  if (version === null) {
    say(`Asking nuget.org for the newest release of ${PACKAGE_ID} ...`);
    let listed;
    try {
      const { response } = await fetchFromNuget(VERSIONS_URL, { signal: signal ?? AbortSignal.timeout(60_000), fetchImpl });
      listed = await response.json();
    } catch (error) {
      if (error instanceof Failure) throw error;
      throw new Failure(`Could not ask nuget.org which versions of ${PACKAGE_ID} there are: ${error?.message ?? error}. A version kept from an earlier run can be named with --sdk-version.`);
    }
    version = latestStable(Array.isArray(listed?.versions) ? listed.versions : []);
  }
  const dir = join(toolsDir, version);
  const toolsOf = (record) => Object.fromEntries(ARCHITECTURES.map((arch) => [arch, { file: join(dir, record.makepri[arch].file), bytes: record.makepri[arch].bytes, sha256: record.makepri[arch].sha256 }]));

  const cached = readToolCache(dir, version);
  if (cached.record) {
    say(`makepri ${version}: kept from an earlier run in ${dir} (package and both exes hash to what was recorded).`);
    return { version, dir, reused: true, record: cached.record, tools: toolsOf(cached.record) };
  }
  say(`makepri ${version}: not kept yet (${cached.reason}). Fetching it from nuget.org.`);
  if (!existsSync(UNZIP)) throw new Failure(`Missing ${UNZIP}. This script runs on macOS, which includes it.`);
  const verifier = findDotnet(dotnet, env);

  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  try {
    const source = packageUrl(version);
    const nupkgName = `${PACKAGE_ID}.${version}.nupkg`;
    const nupkg = join(dir, nupkgName);
    let next = 8 * 1048576;
    const started = Date.now();
    const downloaded = await downloadFile(source, nupkg, {
      signal: signal ?? AbortSignal.timeout(15 * 60_000),
      fetchImpl,
      onProgress: (bytes, total) => {
        if (bytes >= next) {
          say(`  downloaded ${(bytes / 1048576).toFixed(1)}${Number.isFinite(total) ? ` of ${(total / 1048576).toFixed(1)}` : ''} MB`);
          next = bytes + 8 * 1048576;
        }
      },
    });
    say(`Downloaded ${nupkgName}: ${downloaded.bytes} bytes in ${((Date.now() - started) / 1000).toFixed(1)} s, SHA-256 ${downloaded.sha256}`);

    const verified = verifyPackage(nupkg, verifier);
    say(`dotnet nuget verify --all: ${verified.line}`);

    const members = findMakepriMembers(listZip(nupkg));
    const makepri = {};
    for (const arch of ARCHITECTURES) {
      const bytes = extractMember(nupkg, members[arch]);
      const machine = peMachine(bytes);
      // The arm64 folder holds a program for ARM64 (or the ARM64EC form of it); the x64 folder, one for x64. A swapped or damaged file stops here, before the VM runs it.
      if (!(arch === 'arm64' ? machine === 'arm64' || machine === 'arm64ec' : machine === 'x64')) {
        throw new Failure(`${members[arch]} is a ${machine ?? 'non-PE'} program, not a ${arch} one. Not using this package.`);
      }
      const file = `makepri-${arch}.exe`;
      writeFileSync(join(dir, file), bytes);
      makepri[arch] = { member: members[arch], file, bytes: bytes.length, sha256: sha256Of(bytes), machine };
    }

    const record = {
      schema: 1,
      package: PACKAGE_ID,
      version,
      sdk: members.sdk,
      source,
      nupkg: { file: nupkgName, bytes: downloaded.bytes, sha256: downloaded.sha256 },
      verified: { command: 'dotnet nuget verify --all', dotnet: verifier.version, line: verified.line, at: new Date().toISOString() },
      makepri,
    };
    const recordFile = join(dir, CACHE_FILE);
    writeFileSync(`${recordFile}.partial`, `${JSON.stringify(record, null, 2)}\n`);
    renameSync(`${recordFile}.partial`, recordFile);
    return { version, dir, reused: false, record, tools: toolsOf(record) };
  } catch (error) {
    // Nothing is kept of a package that was not taken whole: a folder without cache.json is not a cache, but it should not sit there either.
    rmSync(dir, { recursive: true, force: true });
    throw error;
  }
}

// ---------------------------------------------------------------------------------------------------------------------------------------
// The folders for the VM

/** The files of one package's folder, relative to it with forward slashes: its manifest and its images. */
export function folderFiles() {
  return ['AppxManifest.xml', ...assetImages().map(({ name }) => name)];
}

/**
 * Writes, in `outDir`, the folder of each package: store/ and test/, each with its own AppxManifest.xml and the 60 images in Assets. What an
 * earlier run left there is removed first, and nothing else in `outDir`. The images are cut once, by the function package-msix.mjs cuts with,
 * and copied.
 */
export function stageFolders({ outDir, icon, productName, description, version, sips }) {
  for (const name of [...KINDS, 'received', 'dry-run-install', 'd.ps1']) rmSync(join(outDir, name), { recursive: true, force: true });
  const [first, ...others] = KINDS;
  const names = cutAssetImages({ icon, dir: join(outDir, first), sips });
  for (const kind of others) {
    for (const name of names) {
      mkdirSync(dirname(join(outDir, kind, name)), { recursive: true });
      copyFileSync(join(outDir, first, name), join(outDir, kind, name));
    }
  }
  for (const kind of KINDS) writeFileSync(join(outDir, kind, 'AppxManifest.xml'), manifestFor(kind, { displayName: productName, description, version }));
}

/** Reads the folders back: for each package, its files as `{ path, bytes, sha256 }`. These bytes are what the VM is served and what it is told to expect. */
export function readFolders(outDir) {
  return Object.fromEntries(
    KINDS.map((kind) => [
      kind,
      folderFiles().map((path) => {
        const bytes = readFileSync(join(outDir, kind, path));
        return { path, bytes, sha256: sha256Of(bytes) };
      }),
    ]),
  );
}

const CONTENT_TYPES = { '.png': 'image/png', '.xml': 'application/xml', '.exe': 'application/octet-stream', '.ps1': 'text/plain; charset=utf-8' };

/** The route of the script for the VM: it is added to the map of buildRoutes once it is built, as it names the address the server is on. */
export function scriptRoute(script) {
  return { body: Buffer.from(script, 'utf8'), type: CONTENT_TYPES['.ps1'] };
}

/** A route that answers with JSON built when it is asked, from `state()`: the status of the job. */
export function jsonRoute(state) {
  return { body: () => Buffer.from(`${JSON.stringify(state())}\n`, 'utf8'), type: 'application/json; charset=utf-8' };
}

/** What the Mac holds of the two indexes, as /status says it: for each package null, or the size and SHA-256 of what was kept. */
export function priStatus(received) {
  return Object.fromEntries(KINDS.map((kind) => [kind, received[kind] ? { bytes: received[kind].length, sha256: sha256Of(received[kind]) } : null]));
}

/** What the server serves, as a map from the exact path of a request to `{ body, type }`: both makepri.exe and every file of both folders. The script is added to it by the caller. */
export function buildRoutes({ folders, tools }) {
  const routes = new Map();
  for (const arch of ARCHITECTURES) routes.set(TOOL_PATHS[arch], { body: tools[arch].bytes, type: CONTENT_TYPES['.exe'] });
  for (const [kind, files] of Object.entries(folders)) {
    for (const { path, bytes } of files) routes.set(`/${kind}/${path}`, { body: bytes, type: CONTENT_TYPES[posix.extname(path)] ?? 'application/octet-stream' });
  }
  return routes;
}

// ---------------------------------------------------------------------------------------------------------------------------------------
// The script the VM runs

// The script, with @@NAME@@ where what the Mac knows goes. It is for Windows PowerShell 5.1, which a Windows 11 PC has, and uses nothing else: no
// pwsh syntax (&&, ??, ternary), no module. It is run as text by `iex`, so it has no param block and does not ask where it is, and it keeps
// its variables in a scriptblock of its own, so the shell it is typed in is not left in strict mode. It is only ASCII, as a PowerShell 5.1
// that reads a web page with no charset reads it as Latin-1. Every value the Mac puts in is checked to be plain before it is.
// The script is built from sections, because the one that `pnpm msix:vm` serves (msix-vm.mjs) makes the same indexes first and then goes
// on to do more: both are built from these, so there is one PowerShell for the indexes, and not two.
const VM_HEAD = String.raw`# zWorkTracker: @@WHAT@@
# It was fetched by typing: @@LINE@@
# @@SCOPE@@
& {
  Set-StrictMode -Version Latest
  $ErrorActionPreference = 'Stop'
  $ProgressPreference = 'SilentlyContinue'

  $base = '@@BASE@@'
  $root = '@@ROOT@@'
  $toolPath = @{
@@TOOL_PATHS@@
  }
  $toolHash = @{
@@TOOL_HASHES@@
  }
  $kinds = @('store', 'test')
  $upload = @{
@@UPLOADS@@
  }
  $files = @{
@@FILES@@
  }
  $unplated = @(
@@UNPLATED@@
  )
  $statusPath = '@@STATUS_PATH@@'

`;

const VM_HELPERS = String.raw`  function Write-Ok([string]$Text) {
    Write-Host ('OK   ' + $Text) -ForegroundColor Green
  }

  # What went wrong with a request, with the reason the Mac gave in the body of its answer. Windows PowerShell 5.1 has read that body already
  # and keeps it in ErrorDetails; the response stream is read again from its start only if that is empty.
  function Get-ErrorDetail($Record) {
    $text = $Record.Exception.Message
    $body = ''
    try {
      if ($null -ne $Record.ErrorDetails -and -not [string]::IsNullOrEmpty($Record.ErrorDetails.Message)) {
        $body = $Record.ErrorDetails.Message.Trim()
      }
    } catch {
    }
    if ($body.Length -eq 0) {
      try {
        $response = $Record.Exception.Response
        if ($null -ne $response) {
          $stream = $response.GetResponseStream()
          if ($stream.CanSeek) { $stream.Position = 0 }
          $reader = New-Object System.IO.StreamReader($stream)
          $body = $reader.ReadToEnd().Trim()
          $reader.Dispose()
        }
      } catch {
      }
    }
    if ($body.Length -gt 0) { $text = $text + ' - ' + $body }
    return $text
  }

  function Get-Remote([string]$Url, [string]$Path) {
    try {
      Invoke-WebRequest -UseBasicParsing -Uri $Url -OutFile $Path | Out-Null
    } catch {
      throw ('could not fetch ' + $Url + ': ' + (Get-ErrorDetail $_))
    }
  }

  # What the Mac says it holds and how the job stands, as the object its JSON describes.
  function Get-MacStatus {
    try {
      $reply = Invoke-WebRequest -UseBasicParsing -Uri ($base + $statusPath)
    } catch {
      throw ('could not ask the Mac for its status: ' + (Get-ErrorDetail $_))
    }
    return ($reply.Content | ConvertFrom-Json)
  }

  function Test-Hash([string]$Path, [string]$Expected) {
    $actual = (Get-FileHash -Algorithm SHA256 -LiteralPath $Path).Hash
    if ($actual -ne $Expected) {
      throw ('SHA-256 of ' + $Path + ' is ' + $actual + ' and the Mac sent ' + $Expected + ': the file did not arrive intact')
    }
  }

  function Reset-Directory([string]$Path) {
    $full = [System.IO.Path]::GetFullPath($Path)
    if (-not $full.StartsWith($root + '\', [System.StringComparison]::OrdinalIgnoreCase)) {
      throw ('refusing to clear ' + $full + ', which is not inside ' + $root)
    }
    if (Test-Path -LiteralPath $full) {
      Remove-Item -LiteralPath $full -Recurse -Force
    }
    New-Item -ItemType Directory -Force -Path $full | Out-Null
  }

  function Get-Makepri([string]$Which) {
    $path = Join-Path $root ('makepri-' + $Which + '.exe')
    $address = $base + $toolPath[$Which]
    $expected = $toolHash[$Which]
    Get-Remote $address $path
    Test-Hash $path $expected
    Write-Ok ('fetched makepri-' + $Which + '.exe (' + (Get-Item -LiteralPath $path).Length + ' bytes), SHA-256 matches')
    return $path
  }

  # Whether the program at $Exe STARTS, as { Started, Why }. It is run once with the command help, which only prints how makepri is used and
  # does no work. What it prints and what it exits with are not judged: a makepri that answers with an error of its own has started all the
  # same, and a real error of makepri is dealt with where makepri does its work, as a FAIL. It has not started if PowerShell could not launch
  # it (a PC that cannot run that kind of program, such as an x64 one on a Windows on Arm with no x64 emulation), if PowerShell left no exit
  # code, or if the system ended it with an error code of its own, 0xC followed by seven digits, such as 0xC0000135 (a DLL it needs is
  # missing), 0xC000007B (not a valid image), 0xC0000142 (could not initialise) or 0xC000001D (an instruction that cannot be run).
  function Get-StartResult([string]$Exe) {
    $saved = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    $global:LASTEXITCODE = $null
    try {
      & $Exe 'help' 2>&1 | Out-Null
    } catch {
      $detail = $_.Exception.Message
      if ($null -ne $_.Exception.InnerException) { $detail = $_.Exception.InnerException.Message }
      return [pscustomobject]@{ Started = $false; Why = $detail.Trim() }
    } finally {
      $ErrorActionPreference = $saved
    }
    if ($null -eq $LASTEXITCODE) {
      return [pscustomobject]@{ Started = $false; Why = 'PowerShell did not run it' }
    }
    $hex = '{0:X8}' -f $LASTEXITCODE
    if ($hex.StartsWith('C', [System.StringComparison]::Ordinal)) {
      return [pscustomobject]@{ Started = $false; Why = ('the system ended it with the error code 0x' + $hex) }
    }
    return [pscustomobject]@{ Started = $true; Why = '' }
  }

  function Invoke-MakePri([string]$Line) {
    Write-Host ('     makepri ' + $Line)
    $arguments = $Line.Split(' ')
    $saved = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
      $output = & $makepri @arguments 2>&1 | ForEach-Object { $_.ToString() }
      $code = $LASTEXITCODE
    } finally {
      $ErrorActionPreference = $saved
    }
    if ($code -ne 0) {
      throw ('makepri ' + $Line + ' failed with exit code ' + $code + ': ' + ($output | Out-String).Trim())
    }
  }

  function Get-DumpSample([string]$Text) {
    $lines = $Text.Split([char]10) | Where-Object { $_.Contains('Square44x44Logo') } | Select-Object -First 6
    return (($lines | ForEach-Object { $_.Trim() }) -join ' | ')
  }

  function Remove-Packaging([string]$Path) {
    $xml = New-Object System.Xml.XmlDocument
    $xml.Load($Path)
    $found = @($xml.SelectNodes("//*[local-name()='packaging']"))
    foreach ($node in $found) {
      [void]$node.ParentNode.RemoveChild($node)
    }
    $xml.Save($Path)
    $again = New-Object System.Xml.XmlDocument
    $again.Load($Path)
    if (@($again.SelectNodes("//*[local-name()='packaging']")).Count -ne 0) {
      throw ('the packaging element is still in ' + $Path)
    }
    Write-Ok ('priconfig.xml: ' + $found.Count + ' packaging element removed')
  }

`;

// The top of the work of the script that only makes the indexes, and the end of it. The script of msix-vm.mjs has its own.
const VM_INDEX_TOP = String.raw`  $origin = (Get-Location).Path
  try {
    Write-Host ('zWorkTracker resources.pri maker. It works in ' + $root + ' and nowhere else.')
    New-Item -ItemType Directory -Force -Path $root | Out-Null

`;

// The step that makes the indexes. It is the same text in both scripts, four spaces in, as it sits inside a try block.
const VM_INDEX_STEP = String.raw`    # The makepri that is run is the x64 one, on every PC: the packages are x64, a Windows 11 on Arm runs it by emulation, and the index it makes
    # does not depend on the processor. The arm64 one is fetched only if the x64 one does not start. Whichever has started is the one used for
    # all the work: if it then fails at its work, that is a FAIL, never a reason to try the other.
    $makepri = Get-Makepri 'x64'
    $probe = Get-StartResult $makepri
    if ($probe.Started) {
      Write-Ok 'makepri x64'
    } else {
      $reasonX64 = $probe.Why
      $makepri = Get-Makepri 'arm64'
      $probe = Get-StartResult $makepri
      if (-not $probe.Started) {
        throw ('neither makepri.exe started on this PC. x64: ' + $reasonX64 + ' | arm64: ' + $probe.Why)
      }
      Write-Ok ('makepri arm64 (x64 did not start: ' + $reasonX64 + ')')
    }

    # What the Mac already holds is not made again: a line typed a second time, after one of the two was sent, goes on with the other.
    $mac = Get-MacStatus
    foreach ($kind in $kinds) {
      if ($null -ne $mac.pri.$kind) {
        Write-Ok ($kind + ': the Mac already has its resources.pri, so it is not made again')
        continue
      }
      $dir = Join-Path $root $kind
      $work = Join-Path $root ($kind + '-work')
      Reset-Directory $dir
      Reset-Directory $work
      $count = 0
      foreach ($path in $files[$kind].Keys) {
        $expected = $files[$kind][$path]
        $address = $base + '/' + $kind + '/' + $path
        $target = Join-Path $dir ($path.Replace('/', '\'))
        New-Item -ItemType Directory -Force -Path (Split-Path -Parent $target) | Out-Null
        Get-Remote $address $target
        Test-Hash $target $expected
        $count++
      }
      Write-Ok ($kind + ': ' + $count + ' files fetched, SHA-256 of each matches')

      Push-Location -LiteralPath $work
      try {
        Invoke-MakePri 'createconfig /cf priconfig.xml /dq en-US /o /pv 10.0.0'
        Remove-Packaging (Join-Path $work 'priconfig.xml')
        Invoke-MakePri ('new /cf priconfig.xml /pr ' + $dir + ' /mn ' + $dir + '\AppxManifest.xml /of ' + $dir + '\resources.pri /o')
        Invoke-MakePri ('dump /if ' + $dir + '\resources.pri /of ' + $dir + '\dump.xml /dt detailed /o')
      } finally {
        Pop-Location
      }

      $pri = Join-Path $dir 'resources.pri'
      if (-not (Test-Path -LiteralPath $pri) -or (Get-Item -LiteralPath $pri).Length -eq 0) {
        throw ('makepri made no ' + $pri)
      }
      $bytes = [System.IO.File]::ReadAllBytes((Join-Path $dir 'dump.xml'))
      $asUtf8 = [System.Text.Encoding]::UTF8.GetString($bytes)
      $asUtf16 = [System.Text.Encoding]::Unicode.GetString($bytes)
      $lacking = @()
      foreach ($name in $unplated) {
        $inUtf8 = $asUtf8.IndexOf($name, [System.StringComparison]::OrdinalIgnoreCase) -ge 0
        $inUtf16 = $asUtf16.IndexOf($name, [System.StringComparison]::OrdinalIgnoreCase) -ge 0
        if (-not ($inUtf8 -or $inUtf16)) { $lacking += $name }
      }
      if ($lacking.Count -gt 0) {
        $sample = Get-DumpSample $asUtf8
        if ($sample.Length -eq 0) { $sample = Get-DumpSample $asUtf16 }
        throw ($kind + ': the dump of resources.pri (' + $dir + '\dump.xml) does not list ' + $lacking.Count + ' of the ' + $unplated.Count + ' unplated Square44x44Logo images: ' + ($lacking -join ', ') + '. Lines of the dump that name Square44x44Logo: ' + $sample)
      }
      Write-Ok ($kind + ': resources.pri made (' + (Get-Item -LiteralPath $pri).Length + ' bytes), and its dump lists all ' + $unplated.Count + ' unplated Square44x44Logo images')

      $sendTo = $base + $upload[$kind]
      try {
        $reply = Invoke-WebRequest -UseBasicParsing -Uri $sendTo -Method Put -InFile $pri -ContentType 'application/octet-stream'
      } catch {
        throw ('could not send ' + $pri + ' to ' + $sendTo + ': ' + (Get-ErrorDetail $_))
      }
      if ($reply.StatusCode -lt 200 -or $reply.StatusCode -ge 300) {
        throw ('the Mac answered ' + $reply.StatusCode + ' to ' + $sendTo)
      }
      Write-Ok ($kind + ': sent to the Mac (' + ([string]$reply.Content).Trim() + ')')
    }
`;

const VM_INDEX_END = String.raw`
    Write-Ok 'both resources.pri are on the Mac now. Go back to the Mac: it checks them and saves them.'
    $global:LASTEXITCODE = 0
  } catch {
    Write-Host ('FAIL ' + $_.Exception.Message) -ForegroundColor Red
    $global:LASTEXITCODE = 1
  } finally {
    Set-Location -LiteralPath $origin
  }
}
`;

/** The sections the script is built from, for msix-vm.mjs to build its own from: the head and the helpers, which both scripts have, and the step that makes the indexes. */
export const VM_SECTIONS = Object.freeze({ head: VM_HEAD, helpers: VM_HELPERS, indexStep: VM_INDEX_STEP });

export const PLAIN = /^[A-Za-z0-9._/:-]+$/;
export const PLAIN_ROOT = /^[A-Za-z]:\\[A-Za-z0-9._-]+$/;
export const PLAIN_LINE = /^[\x20-\x7e]+$/;

/** `text` if it is plain enough to sit in a single-quoted PowerShell string and be a name or an address, else a throw. Nothing the Mac puts in can end a string. */
export function plain(text, what, pattern = PLAIN) {
  if (typeof text !== 'string' || !pattern.test(text)) throw new Error(`${what} is not plain enough for the script on the VM: ${JSON.stringify(text)}`);
  return text;
}

/** Fills the @@NAME@@ places of `template` from `fill`. A place nothing fills, one left over, or a character that is not plain ASCII is an error. */
export function fillScript(template, fill) {
  // A function as the replacement: a string would have its $& and $1 read as patterns.
  const text = template.replace(/@@[A-Z_]+@@/g, (place) => {
    if (!Object.hasOwn(fill, place)) throw new Error(`The script on the VM has a place, ${place}, that nothing fills.`);
    return fill[place];
  });
  if (/@@/.test(text)) throw new Error('The script on the VM still has a place left to fill.');
  if (/[^\x09\x0a\x20-\x7e]/.test(text)) throw new Error('The script on the VM has a character that is not plain ASCII.');
  return text;
}

/**
 * The places of VM_SECTIONS.head that both scripts fill, from what the Mac knows: where it serves (`baseUrl`, http://192.168.64.1:8765), the line typed
 * to fetch the script (it is only named in a comment), the SHA-256 of each makepri.exe by architecture (`tools`), the `{ path, sha256 }` of every file
 * of each package's folder (`files`), and the names of the images the dump of each index must list (`unplated`). `what` and `scope` are the first
 * and third comment line. Every value is checked to be plain before it is put in.
 */
export function scriptFills({ baseUrl, tools, files, unplated, line, what, scope }) {
  if (!/^http:\/\/\d{1,3}(\.\d{1,3}){3}:\d{1,5}$/.test(baseUrl)) throw new Error(`baseUrl is not http://<IPv4 address>:<port>: ${JSON.stringify(baseUrl)}`);
  const entry = (key, value) => `    '${plain(key, 'a name')}' = '${plain(value, 'a value')}'`;
  const hash = (value) => plain(value, 'a SHA-256', SHA256);
  const filesBlock = KINDS.map((kind) => {
    const list = files[kind];
    if (!Array.isArray(list) || list.length === 0) throw new Error(`There are no files for the ${kind} package.`);
    return [`    '${kind}' = [ordered]@{`, ...list.map((file) => `      '${plain(file.path, 'a file name')}' = '${hash(file.sha256)}'`), '    }'].join('\n');
  }).join('\n');
  return {
    '@@WHAT@@': plain(what, 'the purpose', PLAIN_LINE),
    '@@LINE@@': plain(line, 'the line to type', PLAIN_LINE),
    '@@SCOPE@@': plain(scope, 'the scope', PLAIN_LINE),
    '@@ROOT@@': plain(VM_DIRECTORY, 'the folder', PLAIN_ROOT),
    '@@BASE@@': baseUrl,
    '@@TOOL_PATHS@@': ARCHITECTURES.map((arch) => entry(arch, TOOL_PATHS[arch])).join('\n'),
    '@@TOOL_HASHES@@': ARCHITECTURES.map((arch) => entry(arch, hash(tools[arch]))).join('\n'),
    '@@UPLOADS@@': KINDS.map((kind) => entry(kind, UPLOAD_PATHS[kind])).join('\n'),
    '@@FILES@@': filesBlock,
    '@@UNPLATED@@': unplated.map((name) => `    '${plain(name, 'an image name')}'`).join(',\n'),
    '@@STATUS_PATH@@': plain(STATUS_PATH, 'the status path'),
  };
}

/**
 * The PowerShell script the VM runs, as text. `baseUrl` is where the Mac serves (http://192.168.64.1:8765), `line` the line typed to fetch the
 * script (it is only named in a comment). `tools` is the SHA-256 of each makepri.exe by architecture, `files` the `{ path, sha256 }` of every
 * file of each package's folder, and `unplated` the names of the images the dump of each index must list. The script works in VM_DIRECTORY
 * only; it names the SHA-256 of everything it fetches and fails, with FAIL and the reason, on the first thing that is wrong.
 */
export function buildVmScript({ baseUrl, tools, files, unplated, line }) {
  const fill = scriptFills({
    baseUrl,
    tools,
    files,
    unplated,
    line,
    what: 'makes the two resources.pri of the MSIX packages on this PC, with makepri, and sends them to the Mac.',
    scope: `Windows PowerShell 5.1, nothing to install. Everything it writes is inside ${VM_DIRECTORY}.`,
  });
  return fillScript(VM_HEAD + VM_HELPERS + VM_INDEX_TOP + VM_INDEX_STEP + VM_INDEX_END, fill);
}
/** The names of the images the dump of an index must list to show the unplated images are in it: Square44x44Logo.targetsize-<size>_altform-unplated.png for each size. */
export function unplatedNames() {
  return assetImages()
    .map(({ name }) => posix.basename(name))
    .filter((name) => name.endsWith('_altform-unplated.png'));
}

// ---------------------------------------------------------------------------------------------------------------------------------------
// The server

/** What is wrong with `bytes` as the resources.pri of the `kind` package, or null. The checks package-msix.mjs makes when it takes the file in. */
export function indexProblem(kind, bytes) {
  try {
    checkResourceIndex(kind, bytes);
    checkIndexImages(bytes);
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

/**
 * Serves `routes` (a map from an exact path to `{ body, type }`, where `body` may be a function that builds the bytes when they are asked for) with
 * GET, and takes a PUT for the names in `uploads` (a map from a kind to its exact path) and no other. Everything is by exact path, as sent: the path
 * is never decoded, joined to a folder or looked up on disk, so `..`, `%2e%2e`, a doubled slash or a listing of a folder find nothing, and are
 * answered 404. A path that exists answers other methods 405 with the one it takes. `routes` may be added to while the server runs.
 *
 * What a PUT must be, for its kind (`rules[kind]` over the defaults `limit` and `validate`): at most `limit` bytes (413, by its Content-Length at
 * once, or, if it came in chunks, when it ends), and accepted by `validate(kind, bytes)`, which returns null or why not (422, with the reason in the
 * body, and kept in `refused`: the name stays free for another try). The first one that passes is kept. A later one with the same bytes is answered
 * 200 and changes nothing, so that an upload sent twice (an answer lost on the way) is no failure; one with other bytes is 409. A kind with
 * `replace` is the opposite: each one that passes replaces the one before. With `peerGate` set to a path that is served, a PUT is taken only from an
 * address that has fetched that path: 403 for any other (review finding R5).
 *
 * The server stops when `isComplete(received)` says so after an upload (by default, when every kind has one), after `timeoutMs`, when `signal`
 * aborts, or on `stop(reason)`; `finished` then says why, and what arrived and what was refused. A connection with nothing to do is kept open for
 * `keepAliveMs` (KEEP_ALIVE_MS). `observe` is told of every request (with the reason of a refusal, as `detail`), `onAccepted(kind, bytes)` of every
 * upload that was kept. Resolves, once it is listening, with `{ host, port, finished, stop, snapshot }`; a Failure if it cannot listen.
 */
export function startServer({
  host,
  port,
  routes,
  uploads = UPLOAD_PATHS,
  rules = {},
  limit = UPLOAD_LIMIT,
  validate = () => null,
  isComplete = (got) => Object.keys(uploads).every((one) => got.has(one)),
  peerGate = null,
  keepAliveMs = KEEP_ALIVE_MS,
  timeoutMs,
  signal,
  observe = () => {},
  onAccepted = () => {},
}) {
  const kindAt = new Map(Object.entries(uploads).map(([kind, path]) => [path, kind]));
  const received = new Map();
  const refused = new Map();
  const fetchers = new Set();
  let reason = null;
  let timer = null;
  let grace = null;

  const server = createServer({ requestTimeout: 60_000, headersTimeout: 20_000, keepAliveTimeout: keepAliveMs }, handle);

  function send(request, path, response, status, body, { headers = {}, then, detail } = {}) {
    const payload = typeof body === 'string' ? Buffer.from(body, 'utf8') : body;
    response.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8', 'Content-Length': payload.length, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...headers });
    response.end(payload, then);
    observe({ method: request.method ?? '', path, status, bytes: payload.length, client: request.socket.remoteAddress ?? '', ...(detail === undefined ? {} : { detail }) });
  }

  function handle(request, response) {
    // A client that goes away in the middle of a request is its own affair: nothing is kept of a body that did not end, and no request is allowed
    // to take the server down by failing with nobody listening, whichever of the answers below it was given.
    request.on('error', () => {});
    // The path as it was sent, with a query cut off. It is looked up whole in two tables and used for nothing else.
    const path = (request.url ?? '').split('?', 1)[0];
    const served = routes.get(path);
    const kind = kindAt.get(path);
    if (served !== undefined) {
      if (request.method !== 'GET') return send(request, path, response, 405, 'This one is only fetched, with GET.\n', { headers: { Allow: 'GET' } });
      let body;
      try {
        body = typeof served.body === 'function' ? served.body() : served.body;
      } catch (error) {
        return send(request, path, response, 500, 'The answer could not be made.\n', { detail: error instanceof Error ? error.message : String(error) });
      }
      if (path === peerGate) fetchers.add(request.socket.remoteAddress ?? '');
      return send(request, path, response, 200, body, { headers: { 'Content-Type': served.type } });
    }
    if (kind !== undefined) {
      if (request.method !== 'PUT') return send(request, path, response, 405, 'This one only takes a PUT.\n', { headers: { Allow: 'PUT' } });
      return receive(request, response, path, kind);
    }
    return send(request, path, response, 404, 'Not found.\n');
  }

  function receive(request, response, path, kind) {
    const rule = { limit, validate, replace: false, ...rules[kind] };
    const client = request.socket.remoteAddress ?? '';
    if (peerGate !== null && !fetchers.has(client)) {
      const why = `An upload is taken only from a PC that has fetched ${peerGate} from this server, and ${client || 'this address'} has not.`;
      return send(request, path, response, 403, `${why}\n`, { headers: { Connection: 'close' }, detail: why });
    }
    const declared = request.headers['content-length'];
    if (declared !== undefined) {
      if (!/^\d+$/.test(declared)) return send(request, path, response, 400, 'Content-Length is not a number.\n', { headers: { Connection: 'close' }, detail: 'Content-Length is not a number.' });
      if (Number(declared) > rule.limit) return send(request, path, response, 413, `At most ${rule.limit} bytes are taken.\n`, { headers: { Connection: 'close' }, detail: `At most ${rule.limit} bytes are taken.` });
    }
    const chunks = [];
    let size = 0;
    request.on('data', (chunk) => {
      size += chunk.length;
      // Over the limit with no Content-Length to say so: keep nothing, read the rest (up to a point), and answer when it ends.
      if (size <= rule.limit) chunks.push(chunk);
      else if (chunks.length > 0) chunks.length = 0;
      if (size > rule.limit * 8) request.destroy();
    });
    // Only a body that ended counts.
    request.on('end', () => {
      if (size > rule.limit) return send(request, path, response, 413, `At most ${rule.limit} bytes are taken.\n`, { headers: { Connection: 'close' }, detail: `At most ${rule.limit} bytes are taken.` });
      if (size === 0) return send(request, path, response, 400, 'There was nothing in the body.\n', { detail: 'There was nothing in the body.' });
      const bytes = Buffer.concat(chunks, size);
      const have = received.get(kind);
      if (have !== undefined && !rule.replace) {
        if (have.equals(bytes)) return send(request, path, response, 200, `already received ${kind}: ${size} bytes, the same as the ones kept\n`);
        const why = `The ${kind} upload was already received, and this one is not the same. It is taken once.`;
        return send(request, path, response, 409, `${why}\n`, { detail: why });
      }
      const problem = rule.validate(kind, bytes);
      if (problem) {
        refused.set(kind, { problem, bytes });
        return send(request, path, response, 422, `${problem}\n`, { detail: problem });
      }
      received.set(kind, bytes);
      refused.delete(kind);
      try {
        onAccepted(kind, bytes, { replaced: have !== undefined });
      } catch (error) {
        observe({ method: '', path: '', status: 0, bytes: 0, client: '', error: `while taking the ${kind} upload: ${error instanceof Error ? error.message : String(error)}` });
      }
      return send(request, path, response, 201, `received ${kind}: ${size} bytes\n`, { then: isComplete(received) ? () => stop('complete') : undefined });
    });
  }

  const snapshot = () => ({ received: Object.fromEntries(received), refused: Object.fromEntries(refused), fetchers: [...fetchers] });

  function stop(why) {
    if (reason !== null) return;
    reason = why;
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
    server.close();
    server.closeIdleConnections();
    // After the last answer there is nothing left to wait for, but a client that is slow to hang up is given a moment. That is so when the
    // caller ends the job itself ('complete', or 'failed' when the VM said it could not go on); a time that ran out or a Ctrl-C drops everyone at once.
    if (why === 'complete' || why === 'failed') grace = setTimeout(() => server.closeAllConnections(), 1000);
    else server.closeAllConnections();
  }
  const onAbort = () => stop('interrupted');

  return new Promise((resolveStart, rejectStart) => {
    const failed = (error) => rejectStart(new Failure(listenProblem(error, host, port)));
    server.once('error', failed);
    server.listen({ host, port, exclusive: true }, () => {
      server.off('error', failed);
      server.on('error', (error) => observe({ method: '', path: '', status: 0, bytes: 0, client: '', error: error.message }));
      const finished = new Promise((resolveFinished) => {
        server.once('close', () => {
          clearTimeout(grace);
          resolveFinished({ reason: reason ?? 'complete', received: Object.fromEntries(received), refused: Object.fromEntries(refused) });
        });
      });
      // The port is read before anything can close the server: a signal that is already aborted does, at once, and a closed server has no address.
      const bound = server.address().port;
      timer = setTimeout(() => stop('timeout'), timeoutMs);
      if (signal?.aborted) onAbort();
      else signal?.addEventListener('abort', onAbort, { once: true });
      resolveStart({ host, port: bound, finished, stop: (why = 'interrupted') => stop(why), snapshot });
    });
  });
}

// ---------------------------------------------------------------------------------------------------------------------------------------
// What the VM sent

/** Something shaped like a resources.pri, with what package-msix.mjs reads and nothing else: the magic, the Identity Name of the package in UTF-16LE, and the path of every image as makepri writes it. For --dry-run and for tests. */
export function sampleIndex(kind) {
  const { name } = identityOf(kind);
  const utf16 = (text) => Buffer.from(text, 'utf16le');
  return Buffer.concat([
    Buffer.from('mrm_pri2', 'latin1'),
    Buffer.alloc(24),
    Buffer.from('[mrm_decn_info][mrm_hschemaex] ', 'latin1'),
    utf16(`ms-appx://${name}/`),
    Buffer.alloc(8),
    utf16(name),
    Buffer.from('[mrm_dataitem] ', 'latin1'),
    ...assetImages().flatMap(({ name: image }) => [Buffer.from(indexPathOf(image), 'latin1'), Buffer.alloc(1)]),
    Buffer.alloc(16),
    Buffer.from('defaffde', 'hex'),
    Buffer.alloc(4),
    Buffer.from('mrm_pri2', 'latin1'),
  ]);
}

/** What `resourceIndexFor` reads files with: the bytes, or null if there is no such file. */
function readIfThere(file) {
  try {
    return readFileSync(file);
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

/**
 * Checks what the VM sent, `received` being the bytes by package (a package that sent nothing has none), and saves each one that passes
 * to `root`/packaging/msix/<package>/resources.pri, through a `.partial` file. A file is taken only if package-msix.mjs would take it:
 * it is read back from where it was put, with resourceIndexFor. Returns `{ installed, problems, missing }`; `installed` holds
 * `{ kind, file, bytes, sha256, replaced }`, `replaced` being the SHA-256 of the file that was there, or null.
 */
export function installIndexes(received, { root }) {
  const installed = [];
  const problems = [];
  const missing = [];
  for (const kind of KINDS) {
    const bytes = received[kind];
    if (!bytes) {
      missing.push(kind);
      continue;
    }
    const problem = indexProblem(kind, bytes);
    if (problem) {
      problems.push({ kind, message: problem });
      continue;
    }
    const file = join(root, 'packaging', 'msix', kind, RESOURCE_INDEX);
    const before = readIfThere(file);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(`${file}.partial`, bytes);
    renameSync(`${file}.partial`, file);
    // The same lookup package-msix.mjs makes, in the same place: if it would turn the file away, so does this, and the run does not end well.
    const back = resourceIndexFor(kind, { env: {}, root, read: readIfThere });
    if (back === null || !back.bytes.equals(bytes)) throw new Error(`${file} was written and does not read back as the index that was received.`);
    installed.push({ kind, file, bytes: bytes.length, sha256: sha256Of(bytes), replaced: before ? sha256Of(before) : null });
  }
  return { installed, problems, missing };
}

// ---------------------------------------------------------------------------------------------------------------------------------------
// --dry-run: the questions the VM would ask

/** One request to the server, with node:http so that the path goes out exactly as written (fetch tidies `..` away before sending it). Resolves with `{ status, headers, body }`. */
export function exchange({ host, port }, { method, path, headers = {}, body }) {
  return new Promise((resolveExchange, rejectExchange) => {
    const request = httpRequest({ host, port, method, path, headers, agent: false }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('error', rejectExchange);
      response.on('end', () => {
        request.destroy();
        resolveExchange({ status: response.statusCode ?? 0, headers: response.headers, body: Buffer.concat(chunks) });
      });
    });
    request.on('error', rejectExchange);
    request.setTimeout(15_000, () => request.destroy(new Error('no answer in 15 seconds')));
    request.end(body);
  });
}

/**
 * Asks the server running at `where` what the VM would, and what a stranger could, and sends it made-up indexes (`sample`, by package). `script`,
 * `tools` (with the SHA-256 of each makepri.exe) and `folders` are what the server was given to serve, as the answers are compared with them.
 * Returns `{ passed, failed }`, lists of lines.
 */
async function selfTest(where, { script, tools, folders, sample }) {
  const passed = [];
  const failed = [];
  const check = async (what, run) => {
    try {
      const detail = await run();
      passed.push(detail ? `${what} (${detail})` : what);
    } catch (error) {
      failed.push(`${what}: ${error instanceof Error ? error.message : String(error)}`);
    }
  };
  const must = (condition, message) => {
    if (!condition) throw new Error(message);
  };
  const ask = (path, options = {}) => exchange(where, { method: 'GET', path, ...options });
  const unplated = folders.store.find(({ path }) => path.endsWith('_altform-unplated.png') && path.includes('targetsize-16'));

  await check('GET /d.ps1 is the script', async () => {
    const answer = await ask(SCRIPT_PATH);
    must(answer.status === 200 && answer.body.equals(Buffer.from(script, 'utf8')), `status ${answer.status}`);
    must(String(answer.headers['content-type']).startsWith('text/plain'), `content-type ${answer.headers['content-type']}`);
    return `${answer.body.length} bytes`;
  });
  await check('GET of an image has the SHA-256 the script names', async () => {
    const answer = await ask(`/store/${unplated.path}`);
    must(answer.status === 200 && sha256Of(answer.body) === unplated.sha256, `status ${answer.status}, SHA-256 ${sha256Of(answer.body)}`);
    return `${unplated.path}, ${answer.body.length} bytes`;
  });
  for (const kind of KINDS) {
    await check(`GET of the ${kind} manifest matches`, async () => {
      const manifest = folders[kind].find(({ path }) => path === 'AppxManifest.xml');
      const answer = await ask(`/${kind}/AppxManifest.xml`);
      must(answer.status === 200 && sha256Of(answer.body) === manifest.sha256, `status ${answer.status}`);
    });
  }
  await check('GET /status says nothing has been received yet', async () => {
    const answer = await ask(STATUS_PATH);
    must(answer.status === 200 && String(answer.headers['content-type']).startsWith('application/json'), `status ${answer.status}, content-type ${answer.headers['content-type']}`);
    const state = JSON.parse(answer.body.toString('utf8'));
    must(state.schema === 1 && state.pri?.store === null && state.pri?.test === null, answer.body.toString('utf8'));
  });
  for (const arch of ARCHITECTURES) {
    await check(`GET of makepri.exe for ${arch} has the SHA-256 the script names`, async () => {
      const answer = await ask(TOOL_PATHS[arch]);
      must(answer.status === 200 && sha256Of(answer.body) === tools[arch].sha256, `status ${answer.status}, SHA-256 ${sha256Of(answer.body)}`);
      return `${answer.body.length} bytes`;
    });
  }
  const refused = [
    ['GET a path with .. in it', { method: 'GET', path: '/store/Assets/../../d.ps1' }, 404],
    ['GET a path with %2e%2e in it', { method: 'GET', path: '/store/Assets/%2e%2e/AppxManifest.xml' }, 404],
    ['GET the folder of a package (no listing)', { method: 'GET', path: '/store/' }, 404],
    ['GET /', { method: 'GET', path: '/' }, 404],
    ['GET a file that does not exist', { method: 'GET', path: '/store/Assets/nope.png' }, 404],
    ['PUT to a name that is not one of the two', { method: 'PUT', path: '/other-resources.pri', body: Buffer.from('x') }, 404],
    ['PUT to a file that is served', { method: 'PUT', path: SCRIPT_PATH, body: Buffer.from('x') }, 405],
    ['POST to a file that is served', { method: 'POST', path: SCRIPT_PATH, body: Buffer.from('x') }, 405],
    ['GET of an upload name', { method: 'GET', path: UPLOAD_PATHS.store }, 405],
    ['PUT with a Content-Length over the limit', { method: 'PUT', path: UPLOAD_PATHS.store, headers: { 'Content-Length': String(UPLOAD_LIMIT + 1) } }, 413],
    ['PUT of something that is not an index', { method: 'PUT', path: UPLOAD_PATHS.store, body: Buffer.from('<html>not found</html>') }, 422],
    ['PUT of the index of the other package', { method: 'PUT', path: UPLOAD_PATHS.store, body: sample.test }, 422],
  ];
  for (const [what, request, status] of refused) {
    await check(`${what} is refused with ${status}`, async () => {
      const answer = await exchange(where, request);
      must(answer.status === status, `answered ${answer.status}`);
    });
  }
  await check('PUT of the Store index is kept', async () => {
    const answer = await exchange(where, { method: 'PUT', path: UPLOAD_PATHS.store, body: sample.store });
    must(answer.status === 201, `answered ${answer.status}: ${answer.body.toString()}`);
  });
  await check('GET /status now says the Store index was received', async () => {
    const state = JSON.parse((await ask(STATUS_PATH)).body.toString('utf8'));
    must(state.pri?.store?.sha256 === sha256Of(sample.store) && state.pri?.test === null, JSON.stringify(state.pri));
  });
  await check('the same Store index sent a second time is accepted with 200, and changes nothing', async () => {
    const answer = await exchange(where, { method: 'PUT', path: UPLOAD_PATHS.store, body: sample.store });
    must(answer.status === 200, `answered ${answer.status}: ${answer.body.toString()}`);
  });
  await check('a second PUT of the Store index with other bytes is refused with 409', async () => {
    const answer = await exchange(where, { method: 'PUT', path: UPLOAD_PATHS.store, body: Buffer.concat([sample.store, Buffer.from('x')]) });
    must(answer.status === 409, `answered ${answer.status}`);
  });
  await check('PUT of the test index is kept, and the server stops', async () => {
    const answer = await exchange(where, { method: 'PUT', path: UPLOAD_PATHS.test, body: sample.test });
    must(answer.status === 201, `answered ${answer.status}: ${answer.body.toString()}`);
  });
  return { passed, failed };
}

// ---------------------------------------------------------------------------------------------------------------------------------------
// The run

/** `text` as one line, cut to `max` characters, with every control character shown as a space: what a VM sends is not trusted with the terminal. */
export function oneLine(text, max = 700) {
  const line = String(text).replace(/[^\x20-\x7e\u00a0-\uffff]+/g, ' ').replace(/\s+/g, ' ').trim();
  return line.length > max ? `${line.slice(0, max - 3)}...` : line;
}

/**
 * The line a request is shown as while the VM is working: the script and the tools, each upload, everything refused (with the reason, which the
 * VM may not manage to show: review finding R1), and one line for each package's files.
 */
export function progressPrinter(say, folders) {
  const counts = new Map();
  return (event) => {
    const prefix = `  ${event.client || 'client'} ${event.method} ${event.path} ${event.status}`;
    if (event.error) return say(`  server error: ${event.error}`);
    const kind = KINDS.find((one) => event.path.startsWith(`/${one}/`));
    if (event.status === 200 && kind) {
      const seen = (counts.get(kind) ?? 0) + 1;
      counts.set(kind, seen);
      if (seen === folders[kind].length) say(`  ${kind}: all ${seen} files sent`);
      return undefined;
    }
    say(prefix);
    if (event.detail) say(`      refused: ${oneLine(event.detail)}`);
    return undefined;
  };
}

/** The summary of what the VM sent: one line for each package, and for one that was only refused, how big the last try was. */
function receivedLines(outcome) {
  return KINDS.map((kind) => {
    const bytes = outcome.received[kind];
    if (bytes) return `  ${kind}: ${bytes.length} bytes, SHA-256 ${sha256Of(bytes)}`;
    const refused = outcome.refused?.[kind];
    return refused ? `  ${kind}: nothing that passed; the last try, ${refused.bytes.length} bytes, was refused` : `  ${kind}: nothing`;
  });
}

/**
 * Runs the whole thing. Returns the exit status: 0 only if both indexes were checked and saved. `root` is the repo, where packaging/ goes, and
 * `signal` stops the run as Ctrl-C does (the tests use it when their stand-in for the VM fails, so that nothing is left waiting).
 */
export async function run(argv, { env = process.env, say = console.log, root = resolve(import.meta.dirname, '..'), signal } = {}) {
  const options = parseOptions(argv);
  if (options.help) {
    say(helpText());
    return 0;
  }
  const dry = options.dryRun;
  const host = dry ? '127.0.0.1' : options.host;
  const port = dry ? 0 : options.port;
  if (dry && (options.host !== DEFAULT_HOST || options.port !== DEFAULT_PORT)) say('--dry-run serves on 127.0.0.1 on a free port, so --host and --port are not used.');

  // Before the work, so that a Mac with no VM running says so at once and not after the download.
  if (!dry) await checkCanListen(host, port);

  const tauriDir = join(root, 'src-tauri');
  let conf;
  try {
    conf = readAppConf(tauriDir);
  } catch (error) {
    throw new Failure(error.message);
  }
  let version;
  try {
    version = msixVersion(conf.version);
  } catch (error) {
    throw new Failure(`The version in src-tauri/tauri.conf.json: ${error.message}`);
  }
  const outDir = resolve(options.outDir ?? join(cargoTargetRoot(tauriDir, env), 'msix-pri'));
  const toolsDir = resolve(options.toolsDir ?? join(homedir(), 'msix-build', 'tools', 'sdk-buildtools'));
  if (!existsSync(SIPS)) throw new Failure(`Missing ${SIPS}. This script runs on macOS, which includes it.`);

  say(`${dry ? 'Dry run: ' : ''}making the resources.pri of the packages of ${conf.productName} ${conf.version} (package version ${version}).`);
  mkdirSync(outDir, { recursive: true });
  stageFolders({ outDir, icon: join(tauriDir, 'icons', 'icon.png'), productName: conf.productName, description: conf.bundle.shortDescription, version });
  const folders = readFolders(outDir);
  say(`Folders for the VM in ${outDir}: ${KINDS.map((kind) => `${kind}/ (${folders[kind].length} files)`).join(', ')}`);

  const makepri = await ensureMakepri({ toolsDir, sdkVersion: options.sdkVersion, dotnet: options.dotnet, env, say });
  const tools = Object.fromEntries(ARCHITECTURES.map((arch) => [arch, { ...makepri.tools[arch], bytes: readFileSync(makepri.tools[arch].file) }]));
  for (const arch of ARCHITECTURES) {
    if (sha256Of(tools[arch].bytes) !== makepri.tools[arch].sha256) throw new Failure(`${makepri.tools[arch].file} changed after it was checked.`);
  }
  say(`makepri from ${PACKAGE_ID} ${makepri.version}${makepri.reused ? ' (kept)' : ''}:`);
  say(`  package SHA-256 ${makepri.record.nupkg.sha256}`);
  say(`  verified: ${makepri.record.verified.line}`);
  for (const arch of ARCHITECTURES) say(`  ${arch}: ${makepri.tools[arch].file}  SHA-256 ${makepri.tools[arch].sha256}`);

  // The script names the address it is served on, and a dry run learns its port only when it is listening: so the script is built then,
  // and added to the routes before anyone is told where to ask for it.
  const scriptFor = (listening) =>
    buildVmScript({
      baseUrl: `http://${listening.host}:${listening.port}`,
      tools: { arm64: tools.arm64.sha256, x64: tools.x64.sha256 },
      files: Object.fromEntries(KINDS.map((kind) => [kind, folders[kind].map(({ path, sha256 }) => ({ path, sha256 }))])),
      unplated: unplatedNames(),
      line: vmLine(listening.host, listening.port),
    });
  const routes = buildRoutes({ folders, tools });
  const controller = new AbortController();
  const onSignal = () => controller.abort();
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);
  if (signal?.aborted) controller.abort();
  else signal?.addEventListener('abort', onSignal, { once: true });
  let serving = null;
  try {
    serving = await startServer({
      host,
      port,
      routes,
      timeoutMs: options.timeoutMinutes * 60_000,
      signal: controller.signal,
      observe: dry ? () => {} : progressPrinter(say, folders),
      validate: indexProblem,
      // Only the PC that was given the script may send an index back.
      peerGate: SCRIPT_PATH,
    });
    const running = serving;
    routes.set(STATUS_PATH, jsonRoute(() => ({ schema: 1, pri: priStatus(running.snapshot().received) })));
    const text = scriptFor(serving);
    routes.set(SCRIPT_PATH, scriptRoute(text));
    const scriptFile = join(outDir, 'd.ps1');
    writeFileSync(scriptFile, text);
    say(`The script for the VM: ${scriptFile} (${text.length} bytes, ASCII, SHA-256 ${sha256Of(Buffer.from(text, 'utf8'))})`);

    if (dry) return await dryRun({ serving, text, tools, folders, outDir, root, say });
    say('');
    say(`Serving on http://${serving.host}:${serving.port} until both files arrive, ${options.timeoutMinutes} minutes pass, or Ctrl-C.`);
    say('In the VM, open PowerShell (not cmd) and type this line, exactly:');
    say('');
    say(`    ${vmLine(serving.host, serving.port)}`);
    say('');
    say('It prints OK lines as it goes and ends with one saying both files were sent; a FAIL line says what went wrong.');
    say('If macOS asks whether node may accept incoming network connections, allow it: the VM reaches the Mac through that. Waiting ...');
    const outcome = await serving.finished;
    return finish(outcome, { outDir, root, say });
  } catch (error) {
    // Whatever went wrong after the server was listening, it does not go on listening, with the process kept alive, until the time is up (review finding R3).
    if (serving !== null) {
      serving.stop();
      await serving.finished;
    }
    throw error;
  } finally {
    process.off('SIGINT', onSignal);
    process.off('SIGTERM', onSignal);
    signal?.removeEventListener('abort', onSignal);
  }
}

/** After the server has stopped: says what arrived, saves it in `outDir/received`, checks it and installs what passes under `root`. Returns the exit status. */
function finish(outcome, { outDir, root, say }) {
  const why = { complete: 'both files arrived', timeout: 'the time ran out', interrupted: 'interrupted' }[outcome.reason] ?? outcome.reason;
  say('');
  say(`The server stopped: ${why}. What arrived:`);
  receivedLines(outcome).forEach((line) => say(line));
  mkdirSync(join(outDir, 'received'), { recursive: true });
  for (const kind of KINDS) if (outcome.received[kind]) writeFileSync(join(outDir, 'received', `${kind}-${RESOURCE_INDEX}`), outcome.received[kind]);
  // An index that was turned away is kept too, to be looked at: what it was is the first thing to ask.
  const refusedFile = (kind) => join(outDir, 'received', `${kind}-refused.pri`);
  for (const kind of KINDS) if (!outcome.received[kind] && outcome.refused?.[kind]) writeFileSync(refusedFile(kind), outcome.refused[kind].bytes);
  const result = installIndexes(outcome.received, { root });
  say('');
  for (const { file, bytes, sha256, replaced } of result.installed) {
    say(`Saved ${file}`);
    say(`  ${bytes} bytes, SHA-256 ${sha256}${replaced ? (replaced === sha256 ? ' (the same as the file that was there)' : `; replaced the file that was there, SHA-256 ${replaced}`) : ''}`);
  }
  for (const { kind, message } of result.problems) say(`NOT saved: what arrived for the ${kind} package cannot be its resource index: ${message}\n  It is kept in ${join(outDir, 'received', `${kind}-${RESOURCE_INDEX}`)}.`);
  for (const kind of result.missing) {
    const refused = outcome.refused?.[kind];
    if (refused) say(`NOT saved: the VM sent an index for the ${kind} package, and it was refused: ${oneLine(refused.problem, 1500)}\n  The refused file is kept in ${refusedFile(kind)}.`);
    else say(`NOT saved: no index arrived for the ${kind} package.`);
  }
  const good = result.problems.length === 0 && result.missing.length === 0;
  say('');
  if (good) {
    say('Both are in packaging/msix. An index depends on the identity and on which images there are, not on the version, so these serve the next versions too: keep them with the repo (git add packaging/msix). Next:');
    say('  pnpm package:msix --identity both');
  } else {
    say('Not done: run this again once the VM step works. What was saved above is valid and stays.');
  }
  return good ? 0 : 1;
}

/** What `promise` resolves to, or null if it has not resolved after `ms` milliseconds. The timer is gone either way, so it holds nothing up. */
async function within(promise, ms) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((resolveLate) => (timer = setTimeout(() => resolveLate(null), ms)))]);
  } finally {
    clearTimeout(timer);
  }
}

/** The part of --dry-run after the server is listening: the questions, the answers, the installation in the build folder, and the check that packaging/ was not touched. */
async function dryRun({ serving, text, tools, folders, outDir, root, say }) {
  const where = { host: serving.host, port: serving.port };
  const packagingBefore = existsSync(join(root, 'packaging'));
  say(`Dry run: serving on http://${serving.host}:${serving.port}. A real run serves on ${DEFAULT_HOST}:${DEFAULT_PORT}, where the VM types: ${vmLine(DEFAULT_HOST, DEFAULT_PORT)}`);
  const sample = Object.fromEntries(KINDS.map((kind) => [kind, sampleIndex(kind)]));
  const { passed, failed } = await selfTest(where, { script: text, tools, folders, sample });
  for (const line of passed) say(`  PASS ${line}`);
  for (const line of failed) say(`  FAIL ${line}`);
  if (failed.length > 0) {
    serving.stop();
    await serving.finished;
    throw new Failure(`${failed.length} of the dry run's checks failed.`);
  }
  // The last PUT was answered, so the server stops at once. If it does not, this says so, instead of waiting for the end of --timeout.
  const outcome = await within(serving.finished, 10_000);
  if (outcome === null) {
    serving.stop();
    await serving.finished;
    throw new Failure('The server did not stop when both files had arrived.');
  }
  const installRoot = join(outDir, 'dry-run-install');
  const code = finishDry(outcome, sample, { outDir, installRoot, say });
  if (existsSync(join(root, 'packaging')) !== packagingBefore) throw new Failure('The dry run changed whether packaging/ exists. It must not touch it.');
  say('packaging/ was not touched.');
  return code;
}

function finishDry(outcome, sample, { outDir, installRoot, say }) {
  if (outcome.reason !== 'complete') throw new Failure(`The server stopped because of ${outcome.reason}, not because both files arrived.`);
  for (const kind of KINDS) if (!outcome.received[kind]?.equals(sample[kind])) throw new Failure(`The ${kind} index the server kept is not the one that was sent.`);
  say('The server stopped when both files had arrived.');
  const result = installIndexes(outcome.received, { root: installRoot });
  if (result.problems.length > 0 || result.missing.length > 0) throw new Failure(`The made-up indexes were not installed: ${JSON.stringify(result)}`);
  for (const { file, bytes, sha256 } of result.installed) say(`Installed (dry run, in the build folder): ${file}\n  ${bytes} bytes, SHA-256 ${sha256}`);
  say(`Dry run done. Nothing was installed in packaging/; ${installRoot} holds the made-up ones. Output folder: ${outDir}`);
  return 0;
}

const here = (() => {
  try {
    return realpathSync(import.meta.filename);
  } catch {
    return null;
  }
})();
const entry = (() => {
  try {
    return process.argv[1] ? realpathSync(process.argv[1]) : null;
  } catch {
    return null;
  }
})();
if (here !== null && here === entry) {
  run(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (error) => {
      console.error(error instanceof Failure ? error.message : error);
      process.exitCode = 1;
    },
  );
}
