// @vitest-environment node
// scripts/make-pri.mjs: the parts that need no VM, no network and no Mac. The command line, the checks on what is fetched from nuget.org,
// the cache of makepri, the PowerShell that the VM is typed to run (as text: pwsh is not installed here, so it is read, not run), the rules of
// the server the VM talks to (run for real, on 127.0.0.1 and a free port), the check that an index lists every image, and the installation
// of what the VM sends. A last suite runs the script itself: --help and the refusals anywhere, and, on a Mac with sips, a whole --dry-run
// with a cache of makepri made in a temporary folder, so that it needs no network.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { request as httpRequest, type IncomingHttpHeaders } from 'node:http';
import { createConnection, createServer } from 'node:net';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import {
  DEFAULT_HOST,
  DEFAULT_PORT,
  DEFAULT_TIMEOUT_MINUTES,
  Failure,
  KEEP_ALIVE_MS,
  SCRIPT_PATH,
  STATUS_PATH,
  TOOL_PATHS,
  UPLOAD_LIMIT,
  UPLOAD_PATHS,
  VM_DIRECTORY,
  addressIsUp,
  buildVmScript,
  compareVersions,
  downloadFile,
  ensureMakepri,
  fetchFromNuget,
  findMakepriMembers,
  folderFiles,
  helpText,
  indexProblem,
  installIndexes,
  isNugetUrl,
  latestStable,
  listenProblem,
  oneLine,
  packageUrl,
  parseOptions,
  peMachine,
  readToolCache,
  run,
  sampleIndex,
  signaturesIn,
  signerProblem,
  startServer,
  unplatedNames,
  vmLine,
  type Architecture,
  type RequestEvent,
  type RunningServer,
  type Served,
  type ServerOptions,
  type ToolCacheRecord,
} from './make-pri.mjs';
import { assetImages, checkIndexImages, imagesLackingInIndex, indexHoldsImage, indexPathOf, resourceIndexFor, type PackageKind } from './msix-manifest.mjs';

const root = resolve(import.meta.dirname, '..');
const kinds: readonly PackageKind[] = ['store', 'test'];
const sha256 = (bytes: Buffer | string): string => createHash('sha256').update(bytes).digest('hex');

/** What a call said when it threw. */
function messageOf(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error('expected the call to throw');
}

/** What an async call said when it rejected. */
async function rejectionOf(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error('expected the call to reject');
}

/** A folder for one test to write in, removed after the suite. */
const folders: string[] = [];
function scratch(): string {
  const folder = realpathSync(mkdtempSync(join(tmpdir(), 'zwt-make-pri-')));
  folders.push(folder);
  return folder;
}
afterAll(() => {
  for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true });
});

interface Answer {
  status: number;
  headers: IncomingHttpHeaders;
  body: Buffer;
}

/** One request, sent as written: node:http does not tidy the path, and fetch would. `chunks` are sent with Transfer-Encoding: chunked. */
function ask(port: number, where: { method?: string; path: string; headers?: Record<string, string>; body?: Buffer | string; chunks?: Buffer[] }): Promise<Answer> {
  return new Promise((resolveAsk, rejectAsk) => {
    const request = httpRequest({ host: '127.0.0.1', port, method: where.method ?? 'GET', path: where.path, headers: where.headers, agent: false }, (response) => {
      const parts: Buffer[] = [];
      response.on('data', (part: Buffer) => parts.push(part));
      response.on('error', rejectAsk);
      response.on('end', () => resolveAsk({ status: response.statusCode ?? 0, headers: response.headers, body: Buffer.concat(parts) }));
    });
    request.on('error', rejectAsk);
    request.setTimeout(4000, () => request.destroy(new Error(`no answer to ${where.method ?? 'GET'} ${where.path}`)));
    if (where.chunks) {
      request.setHeader('Transfer-Encoding', 'chunked');
      for (const chunk of where.chunks) request.write(chunk);
      request.end();
    } else {
      request.end(where.body);
    }
  });
}

/** The first line of what a server answers to bytes written to a plain socket, for a request that has to be sent in pieces or not finished. */
function statusLineFor(port: number, written: string): Promise<string> {
  return new Promise((resolveLine, rejectLine) => {
    const socket = createConnection({ host: '127.0.0.1', port }, () => socket.write(written));
    let seen = '';
    socket.setTimeout(3000, () => {
      socket.destroy();
      rejectLine(new Error(`no answer to ${JSON.stringify(written)}`));
    });
    socket.on('data', (part: Buffer) => {
      seen += part.toString('latin1');
      const end = seen.indexOf('\r\n');
      if (end >= 0) {
        socket.destroy();
        resolveLine(seen.slice(0, end));
      }
    });
    socket.on('error', rejectLine);
  });
}


/** Makes, in `toolsDir`, the folder an earlier run leaves for `version`: stand-ins for the package and both exes, and the cache.json that records their hashes. Returns the exes. */
function keepMakepri(toolsDir: string, version: string): Record<Architecture, Buffer> {
  const dir = join(toolsDir, version);
  mkdirSync(dir, { recursive: true });
  const exes: Record<Architecture, Buffer> = { arm64: Buffer.from('MZ arm64 makepri stand-in'), x64: Buffer.from('MZ x64 makepri stand-in') };
  const nupkg = Buffer.from('a package stand-in');
  writeFileSync(join(dir, 'p.nupkg'), nupkg);
  for (const arch of ['arm64', 'x64'] as const) writeFileSync(join(dir, `makepri-${arch}.exe`), exes[arch]);
  const entry = (file: string, bytes: Buffer, more: object = {}) => ({ file, bytes: bytes.length, sha256: sha256(bytes), ...more });
  writeFileSync(
    join(dir, 'cache.json'),
    JSON.stringify({
      schema: 1,
      package: 'Microsoft.Windows.SDK.BuildTools',
      version,
      sdk: '10.0.99999.0',
      source: packageUrl(version),
      nupkg: entry('p.nupkg', nupkg),
      verified: { command: 'dotnet nuget verify --all', dotnet: '10.0.403', line: 'exit 0, Author signature by CN=Microsoft Corporation', at: '2026-11-03T00:00:00.000Z' },
      makepri: { arm64: entry('makepri-arm64.exe', exes.arm64, { member: 'm', machine: 'arm64' }), x64: entry('makepri-x64.exe', exes.x64, { member: 'm', machine: 'x64' }) },
    }),
  );
  return exes;
}

// ---------------------------------------------------------------------------------------------------------------------------------------

describe('the command line', () => {
  it('has defaults that are the Mac on the UTM shared network, port 8765, and 15 minutes', () => {
    expect(parseOptions([])).toEqual({
      help: false,
      dryRun: false,
      host: '192.168.64.1',
      port: 8765,
      timeoutMinutes: 15,
      outDir: null,
      toolsDir: null,
      sdkVersion: null,
      dotnet: null,
    });
    expect([DEFAULT_HOST, DEFAULT_PORT, DEFAULT_TIMEOUT_MINUTES]).toEqual(['192.168.64.1', 8765, 15]);
  });

  it('takes every option as "--name value" and as "--name=value"', () => {
    const asked = ['--dry-run', '--host', '10.0.0.5', '--port', '9000', '--timeout', '2.5', '--out-dir', '/o', '--tools-dir', '/t', '--sdk-version', '10.0.28000.2957', '--dotnet', '/bin/dotnet'];
    const joined = ['--dry-run', '--host=10.0.0.5', '--port=9000', '--timeout=2.5', '--out-dir=/o', '--tools-dir=/t', '--sdk-version=10.0.28000.2957', '--dotnet=/bin/dotnet'];
    const expected = { help: false, dryRun: true, host: '10.0.0.5', port: 9000, timeoutMinutes: 2.5, outDir: '/o', toolsDir: '/t', sdkVersion: '10.0.28000.2957', dotnet: '/bin/dotnet' };
    expect(parseOptions(asked)).toEqual(expected);
    expect(parseOptions(joined)).toEqual(expected);
  });

  it('turns away what it does not understand, naming it, instead of taking it for a default', () => {
    expect(messageOf(() => parseOptions(['--dryrun']))).toContain('Unknown argument: --dryrun');
    expect(messageOf(() => parseOptions(['--identity', 'both']))).toContain('Unknown argument: --identity both');
    expect(messageOf(() => parseOptions(['--port']))).toContain('--port needs a value');
    expect(messageOf(() => parseOptions(['--host', '1.2.3.4', '--host', '1.2.3.5']))).toContain('--host was given more than once');
    for (const port of ['0', '65536', '-1', 'abc', '80 ', '', '1e3', '08765x']) {
      expect(messageOf(() => parseOptions([`--port=${port}`])), port).toContain('--port must be a whole number from 1 to 65535');
    }
    for (const timeout of ['0', '-1', 'abc', '1441', '', '1e2']) {
      expect(messageOf(() => parseOptions([`--timeout=${timeout}`])), timeout).toContain('--timeout must be a number of minutes');
    }
    for (const version of ['10.0.28000.1-rtm', '10.0.29648.1000-preview', '10.0', 'latest', '', '10.0.1.2.3']) {
      expect(messageOf(() => parseOptions([`--sdk-version=${version}`])), version).toContain('--sdk-version must be a release version');
    }
    expect(messageOf(() => parseOptions(['--tools-dir=']))).toContain('--tools-dir needs a path');
  });

  it('serves for one VM, not for every network: --host is an IPv4 address and never 0.0.0.0', () => {
    for (const host of ['localhost', '::1', 'mac.local', '192.168.64', '192.168.64.256', '']) {
      expect(messageOf(() => parseOptions([`--host=${host}`])), host).toContain('--host must be an IPv4 address');
    }
    expect(messageOf(() => parseOptions(['--host', '0.0.0.0']))).toContain('every network');
    expect(parseOptions(['--host', '127.0.0.1']).host).toBe('127.0.0.1');
  });

  it('lets --help win over everything else on the line', () => {
    expect(parseOptions(['--bogus', '--port=0', '-h']).help).toBe(true);
    expect(parseOptions(['--help']).help).toBe(true);
  });

  it('lists every option in --help, and the command to run next', () => {
    const text = helpText();
    for (const flag of ['--dry-run', '--host', '--port', '--timeout', '--out-dir', '--tools-dir', '--sdk-version', '--dotnet', '--help']) expect(text, flag).toContain(flag);
    expect(text).toContain('pnpm msix:pri');
    expect(text).toContain('pnpm package:msix --identity both');
  });

  it('prints the line to type in the VM as it must be, and builds it from the host and the port', () => {
    expect(vmLine('192.168.64.1', 8765)).toBe('iwr 192.168.64.1:8765/d.ps1 -UseBasicParsing | iex');
    expect(vmLine('192.168.64.1', 9000)).toBe('iwr 192.168.64.1:9000/d.ps1 -UseBasicParsing | iex');
    expect(vmLine('10.0.0.5', 8765)).toBe('iwr 10.0.0.5:8765/d.ps1 -UseBasicParsing | iex');
    expect(SCRIPT_PATH).toBe('/d.ps1');
    // Short, and nothing in it a Portuguese keyboard has to be taught: no quote, backtick, brace or backslash.
    expect(vmLine(DEFAULT_HOST, DEFAULT_PORT).length).toBeLessThan(60);
    expect(vmLine(DEFAULT_HOST, DEFAULT_PORT)).not.toMatch(/['"`{}\\]/);
  });
});

describe('the command line, shared with pnpm msix:vm', () => {
  it('lets the other script set its own default wait and name more options that take a folder, which are null until given and checked like the others', () => {
    const extra = { timeoutMinutes: 60, paths: { '--publish-dir': 'publishDir', '--pri-dir': 'priDir' } } as const;
    expect(parseOptions([], extra)).toEqual({
      help: false,
      dryRun: false,
      host: DEFAULT_HOST,
      port: DEFAULT_PORT,
      timeoutMinutes: 60,
      outDir: null,
      toolsDir: null,
      sdkVersion: null,
      dotnet: null,
      publishDir: null,
      priDir: null,
    });
    expect(parseOptions(['--publish-dir', '/x/y', '--pri-dir=/z', '--timeout', '5'], extra)).toMatchObject({ publishDir: '/x/y', priDir: '/z', timeoutMinutes: 5 });
    expect(messageOf(() => parseOptions(['--publish-dir'], extra))).toContain('--publish-dir needs a value.');
    expect(messageOf(() => parseOptions(['--publish-dir', '  '], extra))).toContain('--publish-dir needs a path');
    expect(messageOf(() => parseOptions(['--publish-dir', 'a', '--publish-dir', 'b'], extra))).toContain('--publish-dir was given more than once.');
    // Without the extra, the option is as unknown as before, and the default is the 15 minutes.
    expect(messageOf(() => parseOptions(['--publish-dir', 'a']))).toContain('Unknown argument: --publish-dir');
    expect(parseOptions([]).timeoutMinutes).toBe(DEFAULT_TIMEOUT_MINUTES);
  });

  it('shows what a VM sent as one line, with every control character gone, because the terminal is not given over to a VM', () => {
    expect(oneLine('a\x1b[31mred\x07\r\nnext\tline')).toBe('a [31mred next line');
    expect(oneLine('  spaced   out  ')).toBe('spaced out');
    expect(oneLine('x'.repeat(50), 20)).toBe(`${'x'.repeat(17)}...`);
    expect(oneLine('Portugu\u00eas: n\u00e3o')).toBe('Portugu\u00eas: n\u00e3o');
    expect(oneLine('\u009b31m')).toBe('31m');
  });
});

describe('the address the server listens on', () => {
  const interfaces = { lo0: [{ address: '127.0.0.1' }], bridge100: [{ address: '192.168.64.1' }, { address: 'fe80::1' }], gone: undefined };

  it('is up when one of the addresses of this Mac is it, and not when none is', () => {
    expect(addressIsUp('192.168.64.1', interfaces)).toBe(true);
    expect(addressIsUp('127.0.0.1', interfaces)).toBe(true);
    expect(addressIsUp('192.168.64.2', interfaces)).toBe(false);
    expect(addressIsUp('192.168.64.1', {})).toBe(false);
    expect(addressIsUp('192.168.64.1', { en0: [{ address: '192.168.50.102' }] })).toBe(false);
  });

  it('says that the UTM VM must be running when the address is not there, and that the port is in use when it is', () => {
    expect(listenProblem({ code: 'EADDRNOTAVAIL' }, '192.168.64.1', 8765)).toMatch(/not an address of this Mac.*start the UTM VM/);
    expect(listenProblem({ code: 'EADDRINUSE' }, '192.168.64.1', 8765)).toMatch(/Port 8765 on 192\.168\.64\.1 is already in use.*--port/);
    expect(listenProblem({ code: 'EACCES' }, '192.168.64.1', 80)).toContain('may not listen on port 80');
    expect(listenProblem(new Error('boom'), 'h', 1)).toBe('Could not listen on h:1: boom');
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------------

describe('which makepri to get from nuget.org', () => {
  it('compares versions as numbers, part by part, not as text', () => {
    expect(compareVersions('10.0.10000.1', '10.0.9999.1')).toBeGreaterThan(0);
    expect(compareVersions('10.0.9999.1', '10.0.10000.1')).toBeLessThan(0);
    expect(compareVersions('10.0.28000.2957', '10.0.28000.2957')).toBe(0);
    expect(compareVersions('10.0.19041', '10.0.19041.1')).toBeLessThan(0);
    expect(compareVersions('10.0.19041', '10.0.19041.0')).toBe(0);
  });

  it('takes the newest release and never a prerelease, however new', () => {
    const listed = ['10.0.26100.9457', '10.0.28000.1-rtm', '10.0.28000.1721', '10.0.28000.1761-preview', '10.0.28000.2957', '10.0.29648.1000-preview', '10.0.28000.2705'];
    expect(latestStable(listed)).toBe('10.0.28000.2957');
    expect(latestStable([...listed].reverse())).toBe('10.0.28000.2957');
    expect(latestStable(['10.0.9999.1', '10.0.10000.1'])).toBe('10.0.10000.1');
    expect(latestStable(['10.0.1.0', 42, null, { v: 1 }, '10.0.2.0'])).toBe('10.0.2.0');
  });

  it('says so when there is no release at all', () => {
    expect(messageOf(() => latestStable(['10.0.1.0-preview', '10.0.2.0-rtm']))).toContain('lists no release version');
    expect(messageOf(() => latestStable([]))).toContain('lists no release version');
  });

  it('asks for the package at the address nuget.org gives for it', () => {
    expect(packageUrl('10.0.28000.2957')).toBe('https://www.nuget.org/api/v2/package/Microsoft.Windows.SDK.BuildTools/10.0.28000.2957');
  });

  it('counts as nuget.org the site and its subdomains over https, and nothing else', () => {
    for (const url of ['https://www.nuget.org/api/v2/package/x/1', 'https://globalcdn.nuget.org/packages/x.nupkg?packageVersion=1', 'https://api.nuget.org/v3-flatcontainer/x/index.json', 'https://nuget.org/']) {
      expect(isNugetUrl(url), url).toBe(true);
    }
    for (const url of [
      'http://www.nuget.org/x',
      'https://evil.example/nuget.org',
      'https://nuget.org.evil.example/',
      'https://evilnuget.org/',
      'https://www.nuget.org@evil.example/',
      'https://user:pass@www.nuget.org/',
      'ftp://www.nuget.org/',
      'file:///etc/passwd',
      '//www.nuget.org/x',
      'www.nuget.org',
      '',
    ]) {
      expect(isNugetUrl(url), url).toBe(false);
    }
  });
});

describe('fetching from nuget.org', () => {
  /** A fetch that answers from a table by address, and remembers what it was asked. It is handed to the functions in place of the real one. */
  function fakeFetch(table: Record<string, () => Response>) {
    const asked: { url: string; redirect: RequestInit['redirect'] }[] = [];
    const fetchImpl = (url: string, init?: RequestInit): Promise<Response> => {
      asked.push({ url, redirect: init?.redirect });
      const make = table[url];
      return make ? Promise.resolve(make()) : Promise.reject(new Error(`unexpected request for ${url}`));
    };
    return { asked, fetchImpl };
  }
  const redirectTo = (location: string, status = 302) => () => new Response(null, { status, headers: { location } });
  const WWW = 'https://www.nuget.org/api/v2/package/Microsoft.Windows.SDK.BuildTools/10.0.1.0';
  const CDN = 'https://globalcdn.nuget.org/packages/microsoft.windows.sdk.buildtools.10.0.1.0.nupkg?packageVersion=10.0.1.0';

  it('follows the redirect from nuget.org to its CDN by hand, one address at a time', async () => {
    const { asked, fetchImpl } = fakeFetch({ [WWW]: redirectTo(CDN), [CDN]: () => new Response('the package') });
    const { response, url } = await fetchFromNuget(WWW, { fetchImpl });
    expect(await response.text()).toBe('the package');
    expect(url).toBe(CDN);
    expect(asked).toEqual([
      { url: WWW, redirect: 'manual' },
      { url: CDN, redirect: 'manual' },
    ]);
  });

  it('reads a relative redirect against the address it came from', async () => {
    const { asked, fetchImpl } = fakeFetch({ [WWW]: redirectTo('/elsewhere/on/the/site'), 'https://www.nuget.org/elsewhere/on/the/site': () => new Response('ok') });
    await fetchFromNuget(WWW, { fetchImpl });
    expect(asked.map(({ url }) => url)).toEqual([WWW, 'https://www.nuget.org/elsewhere/on/the/site']);
  });

  it('never asks an address that is not on nuget.org, whether it is the first or a redirect to it', async () => {
    for (const target of ['https://evil.example/makepri.exe', 'http://www.nuget.org/x', 'https://nuget.org.evil.example/x', 'https://user@www.nuget.org/x', 'file:///etc/passwd']) {
      const { asked, fetchImpl } = fakeFetch({ [WWW]: redirectTo(target), [target]: () => new Response('would be served') });
      const said = await rejectionOf(() => fetchFromNuget(WWW, { fetchImpl }));
      expect(said, target).toContain('only nuget.org is fetched from');
      expect(asked.map(({ url }) => url), target).toEqual([WWW]);
    }
    const { asked, fetchImpl } = fakeFetch({});
    expect(await rejectionOf(() => fetchFromNuget('https://evil.example/x', { fetchImpl }))).toContain('only nuget.org is fetched from');
    expect(asked).toEqual([]);
  });

  it('gives up on a redirect with nowhere to go, on a loop, and on any answer but 200', async () => {
    expect(await rejectionOf(() => fetchFromNuget(WWW, { fetchImpl: fakeFetch({ [WWW]: () => new Response(null, { status: 302 }) }).fetchImpl }))).toContain('nowhere to go');
    expect(await rejectionOf(() => fetchFromNuget(WWW, { fetchImpl: fakeFetch({ [WWW]: redirectTo(WWW) }).fetchImpl }))).toContain('redirected too many times');
    expect(await rejectionOf(() => fetchFromNuget(WWW, { fetchImpl: fakeFetch({ [WWW]: () => new Response('no', { status: 404 }) }).fetchImpl }))).toContain('answered HTTP 404');
    expect(await rejectionOf(() => fetchFromNuget(WWW, { fetchImpl: fakeFetch({ [WWW]: () => new Response('partial', { status: 206 }) }).fetchImpl }))).toContain('answered HTTP 206');
  });

  it('downloads to a file, with its size and SHA-256, and leaves no .partial', async () => {
    const bytes = Buffer.from('the whole package, as bytes');
    const folder = scratch();
    const file = join(folder, 'p.nupkg');
    const { fetchImpl } = fakeFetch({ [WWW]: () => new Response(bytes, { headers: { 'content-length': String(bytes.length) } }) });
    const seen: number[] = [];
    expect(await downloadFile(WWW, file, { fetchImpl, onProgress: (so) => seen.push(so) })).toEqual({ bytes: bytes.length, sha256: sha256(bytes) });
    expect(readFileSync(file).equals(bytes)).toBe(true);
    expect(readdirSync(folder)).toEqual(['p.nupkg']);
    expect(seen.at(-1)).toBe(bytes.length);
  });

  it('refuses a download that is shorter than it said, or larger than it may be, and keeps nothing of it', async () => {
    const folder = scratch();
    const short = fakeFetch({ [WWW]: () => new Response('12345', { headers: { 'content-length': '10' } }) });
    expect(await rejectionOf(() => downloadFile(WWW, join(folder, 'a.nupkg'), { fetchImpl: short.fetchImpl }))).toContain('promised 10 bytes and sent 5');
    const big = fakeFetch({ [WWW]: () => new Response('0123456789') });
    expect(await rejectionOf(() => downloadFile(WWW, join(folder, 'b.nupkg'), { fetchImpl: big.fetchImpl, maxBytes: 4 }))).toContain('is larger than 4 bytes');
    expect(readdirSync(folder)).toEqual([]);
  });
});

describe('the two makepri.exe in the package', () => {
  const real = [
    'bin/10.0.28000.0/arm/makepri.exe',
    'bin/10.0.28000.0/arm64/makeappx.exe',
    'bin/10.0.28000.0/arm64/makepri.exe',
    'bin/10.0.28000.0/x64/makepri.exe',
    'bin/10.0.28000.0/x86/makepri.exe',
    'build/Microsoft.Windows.SDK.BuildTools.props',
    '[Content_Types].xml',
  ];

  it('finds the arm64 one and the x64 one, and names the SDK they are from', () => {
    expect(findMakepriMembers(real)).toEqual({ sdk: '10.0.28000.0', arm64: 'bin/10.0.28000.0/arm64/makepri.exe', x64: 'bin/10.0.28000.0/x64/makepri.exe' });
  });

  it('takes the newest SDK that has both, and an older one when the newest has only one', () => {
    const list = ['bin/10.0.26100.0/arm64/makepri.exe', 'bin/10.0.26100.0/x64/makepri.exe', 'bin/10.0.28000.0/arm64/makepri.exe', 'bin/10.0.28000.0/x64/makepri.exe'];
    expect(findMakepriMembers(list).sdk).toBe('10.0.28000.0');
    expect(findMakepriMembers([...list, 'bin/10.0.29000.0/x64/makepri.exe']).sdk).toBe('10.0.28000.0');
  });

  it('counts only names of exactly that shape: nothing with .., another file, another case or another folder', () => {
    const traps = [
      'bin/10.0.28000.0/arm64/../../../evil/makepri.exe',
      '../bin/10.0.28000.0/x64/makepri.exe',
      '/bin/10.0.28000.0/x64/makepri.exe',
      'bin/10.0.28000.0/x64/makepri.exe.bak',
      'bin/10.0.28000.0/x64/MAKEPRI.EXE',
      'bin/10.0.28000.0/x64/sub/makepri.exe',
      'tools/bin/10.0.28000.0/x64/makepri.exe',
      'bin\\10.0.28000.0\\x64\\makepri.exe',
      'bin/10.0.28000/x64/makepri.exe',
      'bin/10.0.28000.0/arm64ec/makepri.exe',
    ];
    expect(messageOf(() => findMakepriMembers(traps))).toContain('has no bin/<sdk version>/arm64/makepri.exe and x64/makepri.exe');
    expect(findMakepriMembers([...traps, ...real])).toEqual(findMakepriMembers(real));
    expect(messageOf(() => findMakepriMembers([]))).toContain('no makepri.exe at all');
  });

  it('knows which machine an exe is for from its PE header, and that a file that is no PE file is none', () => {
    const exe = (machine: number, { lfanew = 0x80, magic = 0x5a4d, signature = 0x4550 } = {}): Buffer => {
      const bytes = Buffer.alloc(0x100);
      bytes.writeUInt16LE(magic, 0);
      bytes.writeUInt32LE(lfanew, 0x3c);
      if (lfanew + 6 <= bytes.length) {
        bytes.writeUInt32LE(signature, lfanew);
        bytes.writeUInt16LE(machine, lfanew + 4);
      }
      return bytes;
    };
    expect(peMachine(exe(0x8664))).toBe('x64');
    expect(peMachine(exe(0xaa64))).toBe('arm64');
    expect(peMachine(exe(0xa641))).toBe('arm64ec');
    expect(peMachine(exe(0x14c))).toBe('x86');
    expect(peMachine(exe(0x1c0))).toBe('0x1c0');
    expect(peMachine(exe(0x8664, { magic: 0x4d5a }))).toBeNull();
    expect(peMachine(exe(0x8664, { signature: 0 }))).toBeNull();
    expect(peMachine(exe(0x8664, { lfanew: 0xfffffff0 }))).toBeNull();
    expect(peMachine(Buffer.from('MZ'))).toBeNull();
    expect(peMachine(Buffer.alloc(0))).toBeNull();
  });
});

describe('who signed the package', () => {
  // What dotnet 10.0.403 printed for the real Microsoft.Windows.SDK.BuildTools.10.0.28000.2957, on 2026-11-03.
  const printed = `
Verifying Microsoft.Windows.SDK.BuildTools.10.0.28000.2957
Content hash: nTsRheC9AO+if3BykWkRJ4QXkIMfkqufnBFPIcSEOj7rnX60fqiGrORnxzVFnIXJvsMIjlDOvs/K5EzMLA2RKQ==

Signature type: Author
  Subject Name: CN=Microsoft Corporation, O=Microsoft Corporation, L=Redmond, S=Washington, C=US
  SHA256 hash: 9A1B131BEE0605433056A4EA3815478A8E177961A968C6C0027C1093D1FEB630
  Valid from: 08/09/2026 01:00:00 to 03/12/2027 23:59:59

Signature type: Repository
  Subject Name: CN=NuGet.org Repository by Microsoft, O=NuGet.org Repository by Microsoft, L=Redmond, S=Washington, C=US
  SHA256 hash: 1F4B311D9ACC115C8DC8018B5A49E00FCE6DA8E2855F9F014CA6F34570BC482D
  Valid from: 23/02/2024 00:00:00 to 19/05/2027 00:59:59
`;

  it('reads the signatures off what dotnet nuget verify printed', () => {
    expect(signaturesIn(printed)).toEqual([
      { type: 'Author', subject: 'CN=Microsoft Corporation, O=Microsoft Corporation, L=Redmond, S=Washington, C=US' },
      { type: 'Repository', subject: 'CN=NuGet.org Repository by Microsoft, O=NuGet.org Repository by Microsoft, L=Redmond, S=Washington, C=US' },
    ]);
    expect(signaturesIn('error: NU3004: The package is not signed.')).toEqual([]);
  });

  it('accepts Microsoft as the author and nuget.org as the repository', () => {
    expect(signerProblem(signaturesIn(printed))).toBeNull();
  });

  it('turns away a package that dotnet accepted but that another signed, or that has no author or no repository signature', () => {
    const other = signaturesIn(printed.replace(/Microsoft Corporation/g, 'Evil Corporation'));
    expect(signerProblem(other)).toContain('its author signature is by CN=Evil Corporation');
    expect(signerProblem(signaturesIn(printed.replace('Signature type: Author', 'Signature type: Other')))).toContain('its author signature is missing');
    expect(signerProblem(signaturesIn(printed.replace('Signature type: Repository', 'Signature type: Other')))).toContain('its repository signature is missing');
    expect(signerProblem(signaturesIn(printed.replace('CN=NuGet.org Repository by Microsoft', 'CN=Some Mirror')))).toContain('its repository signature is by');
    expect(signerProblem([])).toContain('its author signature is missing');
    // O=Microsoft Corporation must be a whole attribute, not the end of another name.
    expect(signerProblem([{ type: 'Author', subject: 'CN=x, O=NotMicrosoft Corporation' }, ...signaturesIn(printed).slice(1)])).toContain('its author signature is by');
  });

  // Review finding R4: the name Microsoft Corporation inside a quoted common name is not Microsoft's.
  it('turns away a subject that only contains the right name, inside a quoted common name or after another one', () => {
    const [author, repository] = signaturesIn(printed);
    const crafted = [
      'CN="Evil, O=Microsoft Corporation, Ltd", O=Evil Ltd',
      'CN=Evil, O=Microsoft Corporation, L=Redmond, S=Washington, C=US',
      'O=Microsoft Corporation, CN=Evil',
      ' CN=Microsoft Corporation, O=Microsoft Corporation, L=Redmond',
      'CN=Microsoft Corporation, O=Evil, O=Microsoft Corporation',
    ];
    for (const subject of crafted) expect(signerProblem([{ type: 'Author', subject }, repository!]), subject).toContain('its author signature is by');
    for (const subject of ['CN="Evil, CN=NuGet.org Repository by Microsoft, X"', 'CN=Evil, O=NuGet.org Repository by Microsoft', 'O=NuGet.org Repository by Microsoft, CN=NuGet.org Repository by Microsoft']) {
      expect(signerProblem([author!, { type: 'Repository', subject }]), subject).toContain('its repository signature is by');
    }
    // The real subjects, and the same ones with the attributes cut short, still pass.
    expect(signerProblem([{ type: 'Author', subject: 'CN=Microsoft Corporation, O=Microsoft Corporation' }, { type: 'Repository', subject: 'CN=NuGet.org Repository by Microsoft, O=NuGet.org Repository by Microsoft' }])).toBeNull();
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------------

describe('the makepri kept from an earlier run', () => {
  const VERSION = '10.0.99999.1';
  const exes: Record<Architecture, Buffer> = { arm64: Buffer.from('an arm64 makepri, as bytes'), x64: Buffer.from('an x64 makepri, as bytes') };
  const nupkg = Buffer.from('the package, as bytes');

  /** A folder as an earlier run leaves it: the package, both exes and a cache.json that records their hashes. `change` edits the record. */
  function keep(change: (record: Record<string, unknown>) => void = () => {}): { toolsDir: string; dir: string } {
    const toolsDir = scratch();
    const dir = join(toolsDir, VERSION);
    mkdirSync(dir);
    writeFileSync(join(dir, 'p.nupkg'), nupkg);
    for (const arch of ['arm64', 'x64'] as const) writeFileSync(join(dir, `makepri-${arch}.exe`), exes[arch]);
    const file = (name: string, bytes: Buffer) => ({ file: name, bytes: bytes.length, sha256: sha256(bytes) });
    const record: Record<string, unknown> = {
      schema: 1,
      package: 'Microsoft.Windows.SDK.BuildTools',
      version: VERSION,
      sdk: '10.0.99999.0',
      source: packageUrl(VERSION),
      nupkg: file('p.nupkg', nupkg),
      verified: { command: 'dotnet nuget verify --all', dotnet: '10.0.403', line: 'exit 0, Author signature by CN=Microsoft Corporation', at: '2026-11-03T00:00:00.000Z' },
      makepri: {
        arm64: { member: 'bin/10.0.99999.0/arm64/makepri.exe', machine: 'arm64', ...file('makepri-arm64.exe', exes.arm64) },
        x64: { member: 'bin/10.0.99999.0/x64/makepri.exe', machine: 'x64', ...file('makepri-x64.exe', exes.x64) },
      },
    };
    change(record);
    writeFileSync(join(dir, 'cache.json'), JSON.stringify(record));
    return { toolsDir, dir };
  }

  it('is reused when the version is the one asked for and the package and both exes hash to what is recorded', () => {
    const { dir } = keep();
    const found = readToolCache(dir, VERSION);
    expect(found.reason).toBeUndefined();
    const record: ToolCacheRecord | undefined = found.record;
    expect(record?.makepri.arm64.sha256).toBe(sha256(exes.arm64));
    expect(record?.nupkg.sha256).toBe(sha256(nupkg));
  });

  it('makes ensureMakepri fetch nothing, ask nothing and run nothing when it is reused', async () => {
    const { toolsDir, dir } = keep();
    const said: string[] = [];
    const fetchImpl = (): Promise<Response> => Promise.reject(new Error('the network must not be touched'));
    const made = await ensureMakepri({ toolsDir, sdkVersion: VERSION, dotnet: '/nonexistent/dotnet', env: {}, say: (line) => said.push(line), fetchImpl });
    expect(made.reused).toBe(true);
    expect(made.version).toBe(VERSION);
    expect(made.tools.arm64).toEqual({ file: join(dir, 'makepri-arm64.exe'), bytes: exes.arm64.length, sha256: sha256(exes.arm64) });
    expect(made.tools.x64.sha256).toBe(sha256(exes.x64));
    expect(said.join('\n')).toContain('kept from an earlier run');
  });

  it('is not reused when an exe or the package has changed by a byte, and says which', () => {
    for (const name of ['makepri-arm64.exe', 'makepri-x64.exe', 'p.nupkg']) {
      const { dir } = keep();
      const bytes = readFileSync(join(dir, name));
      bytes[0] = (bytes[0] ?? 0) ^ 1;
      writeFileSync(join(dir, name), bytes);
      expect(readToolCache(dir, VERSION).reason, name).toBe(`${name} does not hash to the SHA-256 recorded for it`);
    }
  });

  it('is not reused when a file is gone, the version differs, or there is no cache.json or an unreadable one', () => {
    const gone = keep();
    rmSync(join(gone.dir, 'makepri-x64.exe'));
    expect(readToolCache(gone.dir, VERSION).reason).toBe('makepri-x64.exe is missing');
    const { dir } = keep();
    expect(readToolCache(dir, '10.0.99999.2').reason).toBe(`cache.json is for ${VERSION}, not 10.0.99999.2`);
    expect(readToolCache(join(dir, 'nowhere'), VERSION).reason).toBe('there is no cache.json yet');
    writeFileSync(join(dir, 'cache.json'), '{ not json');
    expect(readToolCache(dir, VERSION).reason).toContain('cache.json cannot be read');
  });

  it('is not reused when cache.json is not one this script wrote: wrong shape, bad hash, a path where a name should be, or no word that it was verified', () => {
    const cases: [string, (record: Record<string, unknown>) => void, string][] = [
      ['another schema', (record) => void (record.schema = 2), 'is not one this script wrote'],
      ['not an object', (record) => void Object.assign(record, { makepri: 'x' }), 'no usable record of the makepri arm64'],
      ['a hash that is not hex', (record) => void Object.assign(record, { nupkg: { file: 'p.nupkg', bytes: 1, sha256: 'ZZ' } }), 'no usable record of the nupkg'],
      ['a path for a file', (record) => void Object.assign(record, { nupkg: { file: '../p.nupkg', bytes: 1, sha256: sha256(nupkg) } }), 'no usable record of the nupkg'],
      ['an absolute path for a file', (record) => void Object.assign(record, { nupkg: { file: '/etc/passwd', bytes: 1, sha256: sha256(nupkg) } }), 'no usable record of the nupkg'],
      ['no word of verification', (record) => void delete record.verified, 'does not say the package was verified'],
    ];
    for (const [what, change, reason] of cases) expect(readToolCache(keep(change).dir, VERSION).reason, what).toContain(reason);
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------------

describe('the PowerShell script for the VM', () => {
  const BASE = 'http://192.168.64.1:8765';
  const LINE = vmLine('192.168.64.1', 8765);
  const files = Object.fromEntries(kinds.map((kind) => [kind, folderFiles().map((path) => ({ path, sha256: sha256(`${kind}:${path}`) }))])) as Record<PackageKind, { path: string; sha256: string }[]>;
  const tools: Record<Architecture, string> = { arm64: sha256('arm64 makepri'), x64: sha256('x64 makepri') };
  const spec = { baseUrl: BASE, line: LINE, tools, files, unplated: unplatedNames() };
  const script = buildVmScript(spec);
  /** The script without its comment lines and the lines of data, to look at the code alone. */
  const code = script
    .split('\n')
    .filter((line) => !/^\s*#/.test(line) && !/^\s*'[^']*' = '[0-9a-f]{64}'$/.test(line))
    .join('\n');

  /** The text of one function of the script text `of`, from its `function` line to its closing brace. */
  const functionOf = (of: string, name: string): string => {
    const start = of.indexOf(`  function ${name}`);
    expect(start, `the script has a function ${name}`).toBeGreaterThanOrEqual(0);
    return of.slice(start, of.indexOf('\n  }\n', start) + 4);
  };
  /** The last line of the choice of makepri, which is made before the Mac is asked what it holds. */
  const CHOICE_END = "      Write-Ok ('makepri arm64 (x64 did not start: ' + $reasonX64 + ')')";

  it('names the SHA-256 of every file it fetches: all 61 of each package, and both makepri.exe', () => {
    for (const kind of kinds) {
      expect(files[kind]).toHaveLength(61);
      for (const { path, sha256: hash } of files[kind]) expect(script, `${kind}/${path}`).toContain(`      '${path}' = '${hash}'`);
    }
    expect(script).toContain(`    'arm64' = '${tools.arm64}'`);
    expect(script).toContain(`    'x64' = '${tools.x64}'`);
    expect(script.match(/= '[0-9a-f]{64}'/g)).toHaveLength(61 * 2 + 2);
    // It compares what it fetched with those, and stops when they differ.
    expect(code).toContain('Get-FileHash -Algorithm SHA256');
    expect(code).toMatch(/if \(\$actual -ne \$Expected\) \{\s+throw/);
    expect(code).toMatch(/Get-Remote \$address \$path\s+Test-Hash \$path \$expected\s+Write-Ok \('fetched makepri-'/);
    expect(code).toMatch(/Get-Remote \$address \$target\s+Test-Hash \$target \$expected/);
    expect(code.match(/^\s+Get-Remote /gm)).toHaveLength(2);
    expect(code.match(/^\s+Test-Hash /gm)).toHaveLength(2);
  });

  it('fetches from the Mac at the address it was given, and from nowhere else', () => {
    expect(script).toContain(`$base = '${BASE}'`);
    expect(script).toContain(`# It was fetched by typing: ${LINE}`);
    expect(buildVmScript({ ...spec, baseUrl: 'http://127.0.0.1:49733', line: vmLine('127.0.0.1', 49733) })).toContain("$base = 'http://127.0.0.1:49733'");
    expect(script.match(/https?:\/\/[^\s'"]+/g)?.filter((url) => !url.startsWith(BASE))).toEqual([]);
    expect(code).not.toMatch(/\b(?:curl|wget|Start-BitsTransfer|WebClient|DownloadFile|DownloadString)\b/);
    // The file fetch, the question about what the Mac holds already (/status), and the index sent: three places, and each goes to $base.
    expect(code.match(/Invoke-WebRequest/g)).toHaveLength(3);
    expect(code.match(/-Uri \(\$base \+ \$statusPath\)/g)).toHaveLength(1);
  });

  it('works inside C:\\zwt-test and nowhere else: no other path, a delete that is checked, and nothing that changes the PC', () => {
    expect(VM_DIRECTORY).toBe('C:\\zwt-test');
    expect(script).toContain("$root = 'C:\\zwt-test'");
    expect(script.match(/[A-Za-z]:\\[^\s'")]*/g)?.filter((path) => !path.startsWith('C:\\zwt-test'))).toEqual([]);
    // The only delete is the one that refuses a folder outside the root.
    expect(code.match(/Remove-Item/g)).toHaveLength(1);
    expect(code).toContain("if (-not $full.StartsWith($root + '\\', [System.StringComparison]::OrdinalIgnoreCase))");
    expect(code).toMatch(/refusing to clear/);
    expect(code).not.toMatch(
      /Set-ExecutionPolicy|Set-ItemProperty|New-ItemProperty|Remove-ItemProperty|Set-MpPreference|Add-MpPreference|SetEnvironmentVariable|Start-Process|Invoke-Expression|\biex\b|Add-Type|Register-|Enable-|Disable-|Install-|Uninstall-|Restart-|Stop-Computer|netsh|schtasks|\breg\b|HKLM|HKCU|\bsc\.exe\b|Set-Content|Out-File|Add-Content|Copy-Item|Move-Item/,
    );
    // The folders it clears are its own: <root>\store, <root>\test and a working folder for each.
    expect(code).toContain("$dir = Join-Path $root $kind");
    expect(code).toContain("$work = Join-Path $root ($kind + '-work')");
  });

  // The packages are x64, and the VM may be Arm: the makepri that runs is the x64 one on every PC (Windows 11 on Arm emulates it), and the arm64
  // one only if the x64 one does not START. The script cannot be run here, so these read it: the choice and the probe are pinned line by line.
  describe('which makepri it runs', () => {
    /** The text of one function of the script, from its `function` line to its closing brace, the comment lines left out. */
    const functionOf = (name: string): string => {
      const start = code.indexOf(`  function ${name}(`);
      expect(start, `the script has a function ${name}`).toBeGreaterThanOrEqual(0);
      return code.slice(start, code.indexOf('\n  }\n', start) + 4);
    };
    /** The choice of makepri, exactly as written in the script. */
    const CHOICE = [
      "    $makepri = Get-Makepri 'x64'",
      '    $probe = Get-StartResult $makepri',
      '    if ($probe.Started) {',
      "      Write-Ok 'makepri x64'",
      '    } else {',
      '      $reasonX64 = $probe.Why',
      "      $makepri = Get-Makepri 'arm64'",
      '      $probe = Get-StartResult $makepri',
      '      if (-not $probe.Started) {',
      "        throw ('neither makepri.exe started on this PC. x64: ' + $reasonX64 + ' | arm64: ' + $probe.Why)",
      '      }',
      "      Write-Ok ('makepri arm64 (x64 did not start: ' + $reasonX64 + ')')",
      '    }',
    ].join('\n');
    const probeOf = (): string => functionOf('Get-StartResult');

    it('runs the x64 one by default, on every PC: it is fetched and tried first, and OK makepri x64 is said when it starts', () => {
      expect(code).toContain(CHOICE);
      expect(code.indexOf("Get-Makepri 'x64'")).toBeGreaterThan(-1);
      expect(code.indexOf("Get-Makepri 'x64'")).toBeLessThan(code.indexOf("Get-Makepri 'arm64'"));
      // The choice is made before any of the work, which is done with the one chosen.
      expect(code.indexOf(CHOICE)).toBeLessThan(code.indexOf('foreach ($kind in $kinds) {'));
      // Both are served and hashed, under their own names; Get-Makepri looks up the address and the SHA-256 of the one it is given, and checks it.
      expect(script).toContain(`    'x64' = '${TOOL_PATHS.x64}'`);
      expect(script).toContain(`    'arm64' = '${TOOL_PATHS.arm64}'`);
      expect(script).toContain(`    'x64' = '${tools.x64}'`);
      expect(script).toContain(`    'arm64' = '${tools.arm64}'`);
      const fetch = functionOf('Get-Makepri');
      expect(fetch).toContain("$path = Join-Path $root ('makepri-' + $Which + '.exe')");
      expect(fetch).toContain('$address = $base + $toolPath[$Which]');
      expect(fetch).toContain('$expected = $toolHash[$Which]');
      expect(fetch).toMatch(/Get-Remote \$address \$path\s+Test-Hash \$path \$expected\s+Write-Ok/);
      expect(fetch).toMatch(/return \$path\s+\}$/);
    });

    it('does not choose by the architecture of the PC: nothing in the script asks which processor it has', () => {
      expect(script).not.toMatch(/PROCESSOR_|AMD64|\bARM64\b|\$env:|GetEnvironmentVariable|Win32_|OSArchitecture|ProcessArchitecture|RuntimeInformation|Is64Bit|IsWow64/);
      expect(script).not.toContain('$arch');
    });

    it('falls back to the arm64 one only if the x64 one did not start: it is fetched only then, and the reason is said', () => {
      // One call of each, the arm64 one inside the branch taken when the x64 one has not started (CHOICE), and no other place that picks a makepri.
      expect(code.match(/Get-Makepri '/g)).toHaveLength(2);
      expect(code.match(/Get-StartResult \$makepri/g)).toHaveLength(2);
      expect(code.match(/\$makepri = /g)).toHaveLength(2);
      // The arm64 one is named in the table of addresses and in these three lines, and nowhere else.
      expect(
        code
          .split('\n')
          .filter((line) => line.includes('arm64'))
          .map((line) => line.trim()),
      ).toEqual([
        `'arm64' = '${TOOL_PATHS.arm64}'`,
        "$makepri = Get-Makepri 'arm64'",
        "throw ('neither makepri.exe started on this PC. x64: ' + $reasonX64 + ' | arm64: ' + $probe.Why)",
        "Write-Ok ('makepri arm64 (x64 did not start: ' + $reasonX64 + ')')",
      ]);
      expect(code.match(/Write-Ok \('makepri arm64 \(x64 did not start: ' \+ \$reasonX64 \+ '\)'\)/g)).toHaveLength(1);
      expect(code.match(/Write-Ok 'makepri x64'/g)).toHaveLength(1);
      // The only try/catch left to catch the work is the one that says FAIL and ends: it has no other makepri to go to.
      const reporter = code.slice(code.lastIndexOf('  } catch {'));
      expect(reporter).toContain("Write-Host ('FAIL ' + $_.Exception.Message) -ForegroundColor Red");
      expect(reporter).not.toMatch(/Get-Makepri|Get-StartResult|arm64|x64|\$makepri/);
    });

    it('fails, with the reason for each, when neither starts, before any of the work', () => {
      expect(code).toContain("throw ('neither makepri.exe started on this PC. x64: ' + $reasonX64 + ' | arm64: ' + $probe.Why)");
      expect(code.indexOf('neither makepri.exe started')).toBeLessThan(code.indexOf('foreach ($kind in $kinds) {'));
      // That throw is a FAIL like any other: the one place that catches it prints FAIL and the PC is left as it was.
      expect(code.match(/throw \('neither /g)).toHaveLength(1);
    });

    it('decides that by running makepri once with help, which only prints how it is used, and discards what it printed', () => {
      const probe = probeOf();
      expect(probe.match(/& \$Exe/g)).toHaveLength(1);
      expect(probe).toContain("& $Exe 'help' 2>&1 | Out-Null");
      // Not a command that does work, and no other program is run to find out.
      expect(probe).not.toMatch(/\b(?:new|createconfig|dump|versioninfo)\b/);
      expect(probe).not.toMatch(/Start-Process|Invoke-Expression|\bcmd\b|Get-Command|Test-Path/);
      // The same stderr rule as the work: an error record from a native command is not an error of the script.
      expect(probe).toContain("$ErrorActionPreference = 'Continue'");
      expect(probe).toMatch(/\} finally \{\s+\$ErrorActionPreference = \$saved\s+\}/);
    });

    it('has not started if it could not be launched, whether PowerShell reports that by an exception or by leaving no exit code', () => {
      const probe = probeOf();
      expect(probe).toMatch(/try \{\s+& \$Exe 'help' 2>&1 \| Out-Null\s+\} catch \{/);
      expect(probe).toMatch(/\} catch \{[^}]*?\$detail = \$_\.Exception\.Message\s+if \(\$null -ne \$_\.Exception\.InnerException\) \{ \$detail = \$_\.Exception\.InnerException\.Message \}\s+return \[pscustomobject\]@\{ Started = \$false; Why = \$detail\.Trim\(\) \}\s+\} finally/);
      // A stale code from an earlier program must not pass for this one's: it is emptied before, and none left after means it did not run.
      expect(probe).toMatch(/\$global:LASTEXITCODE = \$null\s+try \{/);
      expect(probe).toMatch(/if \(\$null -eq \$LASTEXITCODE\) \{\s+return \[pscustomobject\]@\{ Started = \$false; Why = 'PowerShell did not run it' \}\s+\}/);
    });

    it('has not started if the system ended it with an error code of its own, 0xC followed by seven digits, and has started otherwise', () => {
      const probe = probeOf();
      expect(probe).toContain("$hex = '{0:X8}' -f $LASTEXITCODE");
      expect(probe).toMatch(
        /if \(\$hex\.StartsWith\('C', \[System\.StringComparison\]::Ordinal\)\) \{\s+return \[pscustomobject\]@\{ Started = \$false; Why = \('the system ended it with the error code 0x' \+ \$hex\) \}\s+\}\s+return \[pscustomobject\]@\{ Started = \$true; Why = '' \}\s+\}$/,
      );
      // Makepri's own answer is not judged: no exit code is compared with a number, so 0, 1 and an HRESULT such as 0x80070057 all mean it started.
      expect(probe).not.toMatch(/-(?:eq|ne|gt|lt|ge|le)\s+-?(?:\d|0x)/i);
      expect(probe.match(/Started = \$true/g)).toHaveLength(1);
      expect(probe.match(/Started = \$false/g)).toHaveLength(3);
    });

    it('does not fall back when makepri fails at its work: that is a FAIL, from the one function that checks every command, with no other makepri to try', () => {
      const work = functionOf('Invoke-MakePri');
      expect(work).toMatch(/if \(\$code -ne 0\) \{\s+throw \('makepri ' \+ \$Line \+ ' failed with exit code ' \+ \$code \+ ': ' \+ \(\$output \| Out-String\)\.Trim\(\)\)\s+\}/);
      expect(work).not.toMatch(/arm64|x64|Get-Makepri|Get-StartResult|\$makepri =|catch/);
      expect(code.match(/& \$makepri/g)).toHaveLength(1);
      // Nothing after the choice picks again: the work (the loop over the packages) runs with the $makepri the choice left.
      const after = code.slice(code.indexOf(CHOICE) + CHOICE.length);
      expect(after).not.toMatch(/Get-Makepri|Get-StartResult|\$makepri =|\$reasonX64|\$probe/);
      expect(after.match(/Invoke-MakePri /g)).toHaveLength(3);
    });
  });

  it('runs the three makepri commands, in order, for each package, with the removal of <packaging> between the first two', () => {
    const create = "Invoke-MakePri 'createconfig /cf priconfig.xml /dq en-US /o /pv 10.0.0'";
    const remove = "Remove-Packaging (Join-Path $work 'priconfig.xml')";
    const make = "Invoke-MakePri ('new /cf priconfig.xml /pr ' + $dir + ' /mn ' + $dir + '\\AppxManifest.xml /of ' + $dir + '\\resources.pri /o')";
    const dump = "Invoke-MakePri ('dump /if ' + $dir + '\\resources.pri /of ' + $dir + '\\dump.xml /dt detailed /o')";
    const at = [create, remove, make, dump].map((line) => code.indexOf(line));
    expect(at.every((one) => one >= 0), JSON.stringify(at)).toBe(true);
    expect([...at].sort((a, b) => a - b)).toEqual(at);
    for (const line of [create, make, dump]) expect(code.split(line).length - 1, line).toBe(1);
    // The loop runs them for each package in turn: the store, then the test one.
    expect(code).toContain("$kinds = @('store', 'test')");
    expect(code).toContain('foreach ($kind in $kinds) {');
    expect(code.indexOf('foreach ($kind in $kinds)')).toBeLessThan(code.indexOf(create));
  });

  it('checks the exit code after every makepri call, since all of them go through one function that does', () => {
    expect(code.match(/& \$makepri/g)).toHaveLength(1);
    expect(code.match(/Invoke-MakePri[ (]/g)?.length).toBe(1 + 3);
    expect(code).toMatch(/\$code = \$LASTEXITCODE\s+\} finally \{[^}]*\}\s+if \(\$code -ne 0\) \{\s+throw \('makepri ' \+ \$Line \+ ' failed with exit code '/);
    // A command that writes to the error stream is not a failure by itself: the exit code decides.
    expect(code).toContain("$ErrorActionPreference = 'Continue'");
    expect(code).toContain('2>&1');
  });

  it('removes <packaging> from priconfig.xml with the XML DOM, and checks that it is gone, and uses no pattern on the text', () => {
    expect(code).toContain('New-Object System.Xml.XmlDocument');
    expect(code).toContain('.Load($Path)');
    expect(code).toContain('.RemoveChild($node)');
    expect(code).toContain('.Save($Path)');
    expect(code.match(/local-name\(\)='packaging'/g)).toHaveLength(2);
    expect(code).toMatch(/\.Count -ne 0\) \{\s+throw \('the packaging element is still in /);
    expect(code).not.toMatch(/-replace|-match|\[regex\]|Select-String|\.Replace\('<|-creplace/);
  });

  it('checks that the dump lists all 14 unplated Square44x44Logo images, by name, before it sends anything', () => {
    expect(unplatedNames()).toHaveLength(14);
    for (const size of [16, 20, 24, 30, 32, 36, 40, 48, 60, 64, 72, 80, 96, 256]) expect(script, String(size)).toContain(`    'Square44x44Logo.targetsize-${size}_altform-unplated.png'`);
    expect(unplatedNames().filter((name) => name.includes('lightunplated'))).toEqual([]);
    expect(unplatedNames().every((name) => name.endsWith('_altform-unplated.png'))).toBe(true);
    expect(code).toContain('foreach ($name in $unplated) {');
    expect(code).toContain('$asUtf8.IndexOf($name, [System.StringComparison]::OrdinalIgnoreCase) -ge 0');
    expect(code).toContain('$asUtf16.IndexOf($name, [System.StringComparison]::OrdinalIgnoreCase) -ge 0');
    expect(code).toMatch(/if \(\$lacking\.Count -gt 0\) \{[\s\S]*?throw \(\$kind \+ ': the dump of resources\.pri/);
    expect(code.indexOf('$lacking.Count -gt 0')).toBeLessThan(code.indexOf('-Method Put'));
    // When it does not, it shows the lines of the dump that name the images, to say what the dump is like instead.
    expect(code).toContain("$_.Contains('Square44x44Logo')");
    expect(code).toContain("'. Lines of the dump that name Square44x44Logo: ' + $sample");
  });

  it('sends each index back with a PUT of the file to its own name, and stops if the Mac does not take it', () => {
    expect(script).toContain(`    'store' = '${UPLOAD_PATHS.store}'`);
    expect(script).toContain(`    'test' = '${UPLOAD_PATHS.test}'`);
    expect(code).toContain("$sendTo = $base + $upload[$kind]");
    expect(code).toContain("-Uri $sendTo -Method Put -InFile $pri -ContentType 'application/octet-stream'");
    expect(code).toMatch(/\$reply\.StatusCode -lt 200 -or \$reply\.StatusCode -ge 300\) \{\s+throw/);
    expect(code.match(/-Method/g)).toHaveLength(1);
  });

  it('is PowerShell 5.1: strict, quiet, in a scriptblock of its own, with no param block and nothing that asks where the script is', () => {
    expect(code).toContain('Set-StrictMode -Version Latest');
    expect(code).toContain("$ErrorActionPreference = 'Stop'");
    expect(code).toContain("$ProgressPreference = 'SilentlyContinue'");
    expect(script.replace(/^(#.*\n)+/, '').startsWith('& {\n')).toBe(true);
    expect(script.endsWith('}\n')).toBe(true);
    expect(code).not.toMatch(/\bparam\s*\(|\$PSScriptRoot|\$MyInvocation|\$PSCommandPath|\$script:|\$MyInvocation/);
    // None of what only PowerShell 7 has.
    // ConvertFrom-Json is no PowerShell 7 thing: Windows PowerShell 5.1 has it, and reads the Mac's /status with it (the 5.1 cmdlet has no -AsHashtable).
    expect(code).not.toMatch(/&&|\|\||\?\?|\?\.|\?\[|-Parallel|-AsHashtable|-SkipHttpErrorCheck|-AsByteStream|utf8NoBOM|\bpwsh\b/);
    expect(code).not.toMatch(/ \? .* : /);
    expect(code).toContain('-UseBasicParsing');
  });

  it('leaves the PC and the shell it is typed in as they were, and reports a failure by FAIL and a nonzero $LASTEXITCODE rather than by closing the window', () => {
    expect(code).toContain('$origin = (Get-Location).Path');
    expect(code).toMatch(/\} finally \{\s+Set-Location -LiteralPath \$origin\s+\}/);
    expect(code.match(/Push-Location/g)).toHaveLength(1);
    expect(code.match(/Pop-Location/g)).toHaveLength(1);
    expect(code).toContain("Write-Host ('FAIL ' + $_.Exception.Message) -ForegroundColor Red");
    expect(code).toContain('$global:LASTEXITCODE = 1');
    expect(code).toContain('$global:LASTEXITCODE = 0');
    expect(code).not.toMatch(/^\s*exit(\s|$)/m);
    expect(code).toContain("Write-Host ('OK   ' + $Text) -ForegroundColor Green");
  });

  it('is plain ASCII, which a PowerShell 5.1 that reads a page with no charset reads as it is written', () => {
    expect(script).toMatch(/^[\x09\x0a\x20-\x7e]+$/);
    expect(script).not.toMatch(/\r/);
  });

  it('has quotes, braces, parentheses and brackets that match, and no string that runs past its line', () => {
    const stack: string[] = [];
    const pairs: Record<string, string> = { '}': '{', ')': '(', ']': '[' };
    let quote: string | null = null;
    script.split('\n').forEach((raw, number) => {
      for (let at = 0; at < raw.length; at++) {
        const char = raw.charAt(at);
        if (quote !== null) {
          if (char === quote && raw.charAt(at + 1) === quote) at++;
          else if (char === quote) quote = null;
        } else if (char === '#') {
          break;
        } else if (char === "'" || char === '"') {
          quote = char;
        } else if ('{(['.includes(char)) {
          stack.push(char);
        } else if (char in pairs) {
          expect(stack.pop(), `line ${number + 1}: ${raw}`).toBe(pairs[char]);
        }
      }
      expect(quote, `a string runs past line ${number + 1}: ${raw}`).toBeNull();
    });
    expect(stack).toEqual([]);
    // The two strings in double quotes are the XPath ones: nothing in them is expanded.
    for (const text of script.match(/"[^"\n]*"/g) ?? []) expect(text).not.toMatch(/[$`]/);
  });

  // Review finding R1: Windows PowerShell 5.1 has read the body of an error answer already and keeps it in ErrorDetails, so the stream alone shows nothing.
  it('shows the reason the Mac gave when it turned a request away: from ErrorDetails first, and from the response stream rewound to its start if that is empty', () => {
    const detail = functionOf(code, 'Get-ErrorDetail');
    expect(detail).toContain('$text = $Record.Exception.Message');
    expect(detail).toContain('if ($null -ne $Record.ErrorDetails -and -not [string]::IsNullOrEmpty($Record.ErrorDetails.Message)) {');
    expect(detail).toContain('$body = $Record.ErrorDetails.Message.Trim()');
    expect(detail.indexOf('$Record.ErrorDetails.Message')).toBeLessThan(detail.indexOf('GetResponseStream()'));
    expect(detail).toContain('if ($body.Length -eq 0) {');
    expect(detail).toContain('if ($stream.CanSeek) { $stream.Position = 0 }');
    expect(detail.indexOf('$stream.Position = 0')).toBeLessThan(detail.indexOf('ReadToEnd()'));
    expect(detail).toContain("if ($body.Length -gt 0) { $text = $text + ' - ' + $body }");
    // Asking never fails by itself: each way to get the body is tried inside its own try, and the exception message is the answer when there is none.
    expect(detail.match(/\btry \{/g)).toHaveLength(2);
    // Every request that can be turned away reports through it.
    expect(code).toContain("throw ('could not fetch ' + $Url + ': ' + (Get-ErrorDetail $_))");
    expect(code).toContain("throw ('could not send ' + $pri + ' to ' + $sendTo + ': ' + (Get-ErrorDetail $_))");
    expect(code).toContain("throw ('could not ask the Mac for its status: ' + (Get-ErrorDetail $_))");
  });

  // Review finding R2.
  it('asks the Mac what it holds before making an index, leaves out the one it has, and says so, so that a line typed a second time goes on with the other', () => {
    const ask = functionOf(code, 'Get-MacStatus');
    expect(ask).toContain('Invoke-WebRequest -UseBasicParsing -Uri ($base + $statusPath)');
    expect(ask).toContain('return ($reply.Content | ConvertFrom-Json)');
    expect(script).toContain(`  $statusPath = '${STATUS_PATH}'`);
    const loop = code.slice(code.indexOf('$mac = Get-MacStatus'));
    expect(loop).toMatch(/\$mac = Get-MacStatus\s+foreach \(\$kind in \$kinds\) \{\s+if \(\$null -ne \$mac\.pri\.\$kind\) \{\s+Write-Ok \(\$kind \+ ': the Mac already has its resources\.pri, so it is not made again'\)\s+continue\s+\}\s+\$dir = /);
    // After the choice of makepri, before the first thing the loop does, and asked once.
    expect(code.indexOf(CHOICE_END)).toBeLessThan(code.indexOf('$mac = Get-MacStatus'));
    // The definition and the one call.
    expect(code.match(/Get-MacStatus/g)).toHaveLength(2);
    expect(code).toContain("Write-Ok 'both resources.pri are on the Mac now. Go back to the Mac: it checks them and saves them.'");
  });

  it('refuses anything that could end a quote or add a command, wherever the Mac puts a value in', () => {
    const bad = (change: Partial<typeof spec>): string => messageOf(() => buildVmScript({ ...spec, ...change }));
    expect(bad({ baseUrl: "http://192.168.64.1:8765'; Remove-Item C:\\ #" })).toContain('baseUrl is not');
    expect(bad({ baseUrl: 'http://example.com:8765' })).toContain('baseUrl is not');
    expect(bad({ baseUrl: 'http://192.168.64.1' })).toContain('baseUrl is not');
    expect(bad({ line: 'iwr x\n& { evil }' })).toContain('not plain enough');
    expect(bad({ tools: { ...tools, x64: 'not a hash' } })).toContain('a SHA-256 is not plain enough');
    expect(bad({ tools: { ...tools, x64: `${'a'.repeat(63)}'` } })).toContain('a SHA-256 is not plain enough');
    expect(bad({ unplated: ["a.png'; evil; '"] })).toContain('an image name is not plain enough');
    expect(bad({ files: { ...files, store: [{ path: "x'y.png", sha256: sha256('x') }] } })).toContain('a file name is not plain enough');
    expect(bad({ files: { ...files, store: [{ path: 'Assets/ü.png', sha256: sha256('x') }] } })).toContain('a file name is not plain enough');
    expect(bad({ files: { ...files, store: [{ path: 'x.png', sha256: 'F'.repeat(64) }] } })).toContain('a SHA-256 is not plain enough');
    expect(bad({ files: { ...files, test: [] } })).toContain('There are no files for the test package');
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------------

describe('what the server serves and takes', () => {
  const served = (text: string, type = 'application/octet-stream'): { body: Buffer; type: string } => ({ body: Buffer.from(text), type });
  const ROUTES = new Map<string, { body: Buffer; type: string }>([
    [SCRIPT_PATH, served('# the script\n', 'text/plain; charset=utf-8')],
    [TOOL_PATHS.arm64, served('arm64 makepri')],
    [TOOL_PATHS.x64, served('x64 makepri')],
    ['/store/AppxManifest.xml', served('<Package/>', 'application/xml')],
    ['/store/Assets/StoreLogo.png', served('png bytes', 'image/png')],
    ['/test/AppxManifest.xml', served('<Package test/>', 'application/xml')],
  ]);

  const running: RunningServer[] = [];
  afterEach(async () => {
    for (const server of running.splice(0)) {
      server.stop();
      await server.finished;
    }
  });
  async function serve(options: Partial<ServerOptions> = {}): Promise<RunningServer> {
    const server = await startServer({ host: '127.0.0.1', port: 0, routes: ROUTES, timeoutMs: 30_000, ...options });
    running.push(server);
    return server;
  }
  const PRI = { store: sampleIndex('store'), test: sampleIndex('test') };

  it('serves a file it is told of to a GET, with its type, and tells the browser to keep nothing', async () => {
    const { port } = await serve();
    for (const [path, file] of ROUTES) {
      const answer = await ask(port, { path });
      expect(answer.status, path).toBe(200);
      expect(answer.body.equals(file.body), path).toBe(true);
      expect(answer.headers['content-type'], path).toBe(file.type);
      expect(answer.headers['content-length'], path).toBe(String(file.body.length));
      expect(answer.headers['cache-control'], path).toBe('no-store');
    }
  });

  it('answers 404 to a path it was not told of, and lists no folder', async () => {
    const { port } = await serve();
    for (const path of ['/', '/store', '/store/', '/store/Assets', '/store/Assets/', '/nope', '/d.ps1x', '/store/Assets/Other.png', '/test/Assets/StoreLogo.png', '/index.html', '/*']) {
      const answer = await ask(port, { path });
      expect(answer.status, path).toBe(404);
      expect(answer.body.toString(), path).toBe('Not found.\n');
    }
  });

  it('answers 404 to every way of reaching a file by another route than its exact path: dot segments, encodings, case, slashes, and what is not a path', async () => {
    const { port } = await serve();
    const paths = [
      '/store/Assets/../AppxManifest.xml',
      '/store/Assets/../../d.ps1',
      '/../d.ps1',
      '/store/./AppxManifest.xml',
      '/store/Assets/%2e%2e/AppxManifest.xml',
      '/store/Assets/%2E%2E%2FAppxManifest.xml',
      '/store/Assets/..%2fAppxManifest.xml',
      '/store%2fAppxManifest.xml',
      '/d%2eps1',
      '/d.ps1%00',
      '/d.ps1%00.png',
      '//d.ps1',
      '/store//AppxManifest.xml',
      '/store/AppxManifest.xml/',
      '/store/AppxManifest.xml/.',
      '/store/AppxManifest.xml/..',
      '/STORE/AppxManifest.xml',
      '/store/appxmanifest.xml',
      '/store\\AppxManifest.xml',
      '\\store\\AppxManifest.xml',
      '/store/Assets\\..\\AppxManifest.xml',
      'http://127.0.0.1/d.ps1',
      '/d.ps1;x',
      '/d.ps1 ',
    ].filter((path) => !path.includes(' '));
    for (const path of paths) {
      const answer = await ask(port, { path });
      // What is not even a path (it does not start with a slash) may be turned away by the HTTP parser itself, with 400.
      expect(path.startsWith('/') ? [404] : [400, 404], path).toContain(answer.status);
      expect(answer.body.toString(), path).not.toContain('script');
    }
    // A request line with a space in it cannot be sent by node:http, so it is written by hand.
    expect(await statusLineFor(port, 'GET /d.ps1 /../d.ps1 HTTP/1.1\r\nHost: x\r\n\r\n')).toMatch(/^HTTP\/1\.1 (400|404)/);
  });

  it('cuts a query off and serves the file, and nothing else about the address is read', async () => {
    const { port } = await serve();
    expect((await ask(port, { path: '/d.ps1?x=1' })).status).toBe(200);
    expect((await ask(port, { path: '/store/../d.ps1?x=1' })).status).toBe(404);
  });

  it('takes no method but GET for a file it serves, and says which it takes', async () => {
    const { port } = await serve();
    for (const method of ['PUT', 'POST', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS']) {
      const answer = await ask(port, { method, path: SCRIPT_PATH, body: method === 'PUT' || method === 'POST' ? 'x' : undefined });
      expect(answer.status, method).toBe(405);
      expect(answer.headers.allow, method).toBe('GET');
    }
  });

  it('takes a PUT for exactly two names, /store-resources.pri and /test-resources.pri, and answers 404 to any other', async () => {
    expect(UPLOAD_PATHS).toEqual({ store: '/store-resources.pri', test: '/test-resources.pri' });
    const { port } = await serve();
    for (const path of ['/other.pri', '/resources.pri', '/Store-Resources.pri', '/store-resources.pri/', '/store-resources.pri.bak', '/store/resources.pri', '/store-resources.pri/../test-resources.pri', '/%73tore-resources.pri', '/']) {
      const answer = await ask(port, { method: 'PUT', path, body: PRI.store });
      expect(answer.status, path).toBe(404);
    }
    const answer = await ask(port, { method: 'GET', path: UPLOAD_PATHS.store });
    expect(answer.status).toBe(405);
    expect(answer.headers.allow).toBe('PUT');
    for (const method of ['POST', 'DELETE', 'PATCH']) expect((await ask(port, { method, path: UPLOAD_PATHS.store, body: 'x' })).status, method).toBe(405);
  });

  it('keeps what a PUT carried, whole, and answers 201 with the size', async () => {
    const received: Record<string, Buffer> = {};
    const server = await serve({ timeoutMs: 100 });
    const answer = await ask(server.port, { method: 'PUT', path: UPLOAD_PATHS.store, body: PRI.store });
    expect(answer.status).toBe(201);
    expect(answer.body.toString()).toBe(`received store: ${PRI.store.length} bytes\n`);
    server.stop();
    const outcome = await server.finished;
    Object.assign(received, outcome.received);
    expect(received.store?.equals(PRI.store)).toBe(true);
    expect(Object.keys(received)).toEqual(['store']);
  });

  // Review finding R2: a line typed in the VM a second time, after one index was sent, sends that one again; and so does a client whose answer was lost.
  it('takes each name once: a second PUT of the same bytes is 200 and changes nothing, one of other bytes is 409 and changes nothing', async () => {
    const server = await serve();
    expect((await ask(server.port, { method: 'PUT', path: UPLOAD_PATHS.store, body: PRI.store })).status).toBe(201);
    const same = await ask(server.port, { method: 'PUT', path: UPLOAD_PATHS.store, body: PRI.store });
    expect(same.status).toBe(200);
    expect(same.body.toString()).toBe(`already received store: ${PRI.store.length} bytes, the same as the ones kept\n`);
    for (const body of [Buffer.concat([PRI.store, Buffer.from('x')]), Buffer.from('something else'), PRI.test]) {
      const other = await ask(server.port, { method: 'PUT', path: UPLOAD_PATHS.store, body });
      expect(other.status).toBe(409);
      expect(other.body.toString()).toContain('already received');
    }
    expect((await ask(server.port, { method: 'PUT', path: UPLOAD_PATHS.test, body: PRI.test })).status).toBe(201);
    const outcome = await server.finished;
    expect(outcome.reason).toBe('complete');
    expect(outcome.received.store?.equals(PRI.store)).toBe(true);
  });

  it('takes the first of PUTs of one name sent together: the same bytes again are 200, other bytes are 409', async () => {
    const server = await serve();
    const same = await Promise.all([PRI.store, PRI.store, PRI.store].map((body) => ask(server.port, { method: 'PUT', path: UPLOAD_PATHS.store, body })));
    expect(same.map(({ status }) => status).sort()).toEqual([200, 200, 201]);
    const others = await Promise.all([Buffer.from('a'), Buffer.from('b')].map((body) => ask(server.port, { method: 'PUT', path: UPLOAD_PATHS.store, body })));
    expect(others.map(({ status }) => status)).toEqual([409, 409]);
  });

  it('takes at most the limit: a Content-Length above it is 413 at once, without a body, and nothing is kept', async () => {
    const server = await serve({ limit: 1024 });
    expect(await statusLineFor(server.port, `PUT ${UPLOAD_PATHS.store} HTTP/1.1\r\nHost: x\r\nContent-Length: 1025\r\n\r\n`)).toBe('HTTP/1.1 413 Payload Too Large');
    expect(await statusLineFor(server.port, `PUT ${UPLOAD_PATHS.store} HTTP/1.1\r\nHost: x\r\nContent-Length: 99999999999\r\n\r\n`)).toBe('HTTP/1.1 413 Payload Too Large');
    expect((await ask(server.port, { method: 'PUT', path: UPLOAD_PATHS.store, body: Buffer.alloc(1024, 1) })).status).toBe(201);
  });

  it('takes a body of exactly the limit and refuses one a byte over, sent with a Content-Length or in chunks', async () => {
    const server = await serve({ limit: 1024 });
    const over = Buffer.alloc(1025, 2);
    expect((await ask(server.port, { method: 'PUT', path: UPLOAD_PATHS.store, chunks: [over.subarray(0, 600), over.subarray(600)] })).status).toBe(413);
    expect((await ask(server.port, { method: 'PUT', path: UPLOAD_PATHS.store, chunks: [Buffer.alloc(2048, 3), Buffer.alloc(2048, 3)] })).status).toBe(413);
    expect((await ask(server.port, { method: 'PUT', path: UPLOAD_PATHS.store, chunks: [Buffer.alloc(1000, 4), Buffer.alloc(24, 4)] })).status).toBe(201);
    expect((await ask(server.port, { method: 'PUT', path: UPLOAD_PATHS.test, body: Buffer.alloc(1025, 5) })).status).toBe(413);
    const outcome = await (async () => {
      server.stop();
      return server.finished;
    })();
    // The refused ones left nothing, and the one of exactly 1024 bytes was kept.
    expect(Object.keys(outcome.received)).toEqual(['store']);
    expect(outcome.received.store?.length).toBe(1024);
  });

  it('has a limit of 2 MB, and a Content-Length of a byte more is refused', async () => {
    expect(UPLOAD_LIMIT).toBe(2 * 1024 * 1024);
    const server = await serve();
    expect(await statusLineFor(server.port, `PUT ${UPLOAD_PATHS.test} HTTP/1.1\r\nHost: x\r\nContent-Length: ${UPLOAD_LIMIT + 1}\r\n\r\n`)).toBe('HTTP/1.1 413 Payload Too Large');
  });

  it('refuses an empty body and a Content-Length that is not a number, and keeps the name free', async () => {
    const server = await serve();
    const empty = await ask(server.port, { method: 'PUT', path: UPLOAD_PATHS.store });
    expect(empty.status).toBe(400);
    expect(await statusLineFor(server.port, `PUT ${UPLOAD_PATHS.store} HTTP/1.1\r\nHost: x\r\nContent-Length: 0x10\r\n\r\n`)).toMatch(/^HTTP\/1\.1 400/);
    expect((await ask(server.port, { method: 'PUT', path: UPLOAD_PATHS.store, body: PRI.store })).status).toBe(201);
  });

  it('keeps nothing of an upload that stops half way', async () => {
    const server = await serve();
    await new Promise<void>((done) => {
      const socket = createConnection({ host: '127.0.0.1', port: server.port }, () => {
        socket.write(`PUT ${UPLOAD_PATHS.store} HTTP/1.1\r\nHost: x\r\nContent-Length: 500\r\n\r\n${'x'.repeat(100)}`);
        socket.end();
      });
      // Read what comes back (a 400), or the socket never sees the end of it.
      socket.resume();
      socket.on('close', () => done());
      socket.on('error', () => done());
    });
    expect((await ask(server.port, { method: 'PUT', path: UPLOAD_PATHS.store, body: PRI.store })).status).toBe(201);
  });

  it('asks validate about what came in: what it refuses is 422 with its reason and is not kept, and the name stays free', async () => {
    const asked: [PackageKind, number][] = [];
    const server = await serve({
      validate: (kind, bytes) => {
        asked.push([kind, bytes.length]);
        return indexProblem(kind, bytes);
      },
    });
    const html = await ask(server.port, { method: 'PUT', path: UPLOAD_PATHS.store, body: '<html>not found</html>' });
    expect(html.status).toBe(422);
    expect(html.body.toString()).toContain('it is not a PRI file');
    const other = await ask(server.port, { method: 'PUT', path: UPLOAD_PATHS.store, body: PRI.test });
    expect(other.status).toBe(422);
    expect(other.body.toString()).toContain('it names the identity of the test package');
    const stale = await ask(server.port, { method: 'PUT', path: UPLOAD_PATHS.test, body: PRI.test.subarray(0, 60) });
    expect(stale.status).toBe(422);
    expect((await ask(server.port, { method: 'PUT', path: UPLOAD_PATHS.store, body: PRI.store })).status).toBe(201);
    expect(asked.map(([kind]) => kind)).toEqual(['store', 'store', 'test', 'store']);
  });

  it('serves what a route builds when it is asked, each time, and answers 500 with the reason if building it fails', async () => {
    let asked = 0;
    const routes = new Map<string, Served>([
      ...ROUTES,
      ['/status', { body: () => Buffer.from(`asked ${++asked}`), type: 'text/plain' }],
      [
        '/broken',
        {
          body: () => {
            throw new Error('no answer today');
          },
          type: 'text/plain',
        },
      ],
    ]);
    const seen: string[] = [];
    const server = await serve({ routes, observe: ({ path, status, detail }) => seen.push(`${path} ${status} ${detail ?? ''}`.trim()) });
    expect((await ask(server.port, { path: '/status' })).body.toString()).toBe('asked 1');
    expect((await ask(server.port, { path: '/status' })).body.toString()).toBe('asked 2');
    expect((await ask(server.port, { path: '/broken' })).status).toBe(500);
    expect(seen).toContain('/broken 500 no answer today');
    // A route can be added while the server runs, as the script is once the server knows its own address.
    routes.set('/later', { body: Buffer.from('there now'), type: 'text/plain' });
    expect((await ask(server.port, { path: '/later' })).body.toString()).toBe('there now');
  });

  // Review finding R1: the VM may not show why an index was turned away, so the server tells whoever listens, and keeps the file that was refused.
  it('tells why it refused an upload to whoever asked to know, and hands back the last refusal of each name, with its bytes, until a later upload of that name is kept', async () => {
    const seen: RequestEvent[] = [];
    const server = await serve({ validate: indexProblem, observe: (event) => seen.push(event) });
    expect((await ask(server.port, { method: 'PUT', path: UPLOAD_PATHS.store, body: PRI.test })).status).toBe(422);
    expect((await ask(server.port, { method: 'PUT', path: UPLOAD_PATHS.store, body: '<html>not found</html>' })).status).toBe(422);
    expect((await ask(server.port, { method: 'PUT', path: UPLOAD_PATHS.store, body: PRI.store })).status).toBe(201);
    expect((await ask(server.port, { method: 'PUT', path: UPLOAD_PATHS.test, body: 'nope' })).status).toBe(422);
    const refusals = seen.filter(({ status }) => status === 422);
    expect(refusals.map(({ detail }) => detail ?? '')).toEqual([
      expect.stringContaining('it names the identity of the test package, rustcircle.zWorkTracker.Test'),
      expect.stringContaining('it is not a PRI file'),
      expect.stringContaining('it is not a PRI file'),
    ]);
    // The refusal of the store is forgotten when a good one is kept; the test one stays.
    server.stop();
    const outcome = await server.finished;
    expect(Object.keys(outcome.received)).toEqual(['store']);
    expect(Object.keys(outcome.refused)).toEqual(['test']);
    expect(outcome.refused.test?.problem).toContain('it is not a PRI file');
    expect(outcome.refused.test?.bytes.toString()).toBe('nope');
    // Every answer that is a refusal of an upload carries its reason; a plain 404 or 405 has none.
    expect(seen.filter(({ status }) => status === 404 || status === 405).every(({ detail }) => detail === undefined)).toBe(true);
  });

  it('takes a limit, a check and "replace" for each kind of upload on its own, over the defaults, and stops when the caller says it is done', async () => {
    const uploads = { ...UPLOAD_PATHS, report: '/wack-report.xml', status: '/vm-status.json' };
    type Kind = keyof typeof uploads;
    const kept: string[] = [];
    let done = false;
    const server = await startServer<Kind>({
      host: '127.0.0.1',
      port: 0,
      routes: ROUTES,
      timeoutMs: 30_000,
      uploads,
      isComplete: () => done,
      rules: {
        report: { limit: 100 },
        status: { limit: 50, replace: true, validate: (_kind, bytes) => (bytes.toString().startsWith('{') ? null : 'not JSON') },
      },
      onAccepted: (kind, bytes, { replaced }) => kept.push(`${kind}:${bytes.length}${replaced ? ':replaced' : ''}`),
    });
    try {
      // The report: at most 100 bytes, kept once, the same again is no conflict.
      expect((await ask(server.port, { method: 'PUT', path: uploads.report, body: Buffer.alloc(101, 1) })).status).toBe(413);
      expect((await ask(server.port, { method: 'PUT', path: uploads.report, body: Buffer.alloc(100, 1) })).status).toBe(201);
      expect((await ask(server.port, { method: 'PUT', path: uploads.report, body: Buffer.alloc(100, 1) })).status).toBe(200);
      expect((await ask(server.port, { method: 'PUT', path: uploads.report, body: Buffer.alloc(100, 2) })).status).toBe(409);
      // The status: 50 bytes, checked, and each one that passes replaces the one before.
      expect((await ask(server.port, { method: 'PUT', path: uploads.status, body: Buffer.alloc(51, 1) })).status).toBe(413);
      const bad = await ask(server.port, { method: 'PUT', path: uploads.status, body: 'plain text' });
      expect(bad.status).toBe(422);
      expect(bad.body.toString()).toBe('not JSON\n');
      expect((await ask(server.port, { method: 'PUT', path: uploads.status, body: '{"step":"a"}' })).status).toBe(201);
      expect((await ask(server.port, { method: 'PUT', path: uploads.status, body: '{"step":"b"}' })).status).toBe(201);
      // An index still has the 2 MB the server was given, and its own check (none here).
      expect((await ask(server.port, { method: 'PUT', path: uploads.store, body: Buffer.alloc(1000, 3) })).status).toBe(201);
      expect(kept).toEqual(['report:100', 'status:12', 'status:12:replaced', 'store:1000']);
      expect(server.snapshot().received.status?.toString()).toBe('{"step":"b"}');
      // Nothing stops it but the caller: three kinds have arrived and it goes on.
      expect((await ask(server.port, { path: SCRIPT_PATH })).status).toBe(200);
      done = true;
      expect((await ask(server.port, { method: 'PUT', path: uploads.test, body: Buffer.alloc(10, 4) })).status).toBe(201);
      expect((await server.finished).reason).toBe('complete');
    } finally {
      server.stop();
    }
  });

  // Review finding R5.
  it('with a gate, takes an upload only from an address that has fetched the path of the gate, and says why to the others', async () => {
    const seen: RequestEvent[] = [];
    const server = await serve({ peerGate: SCRIPT_PATH, observe: (event) => seen.push(event) });
    const before = await ask(server.port, { method: 'PUT', path: UPLOAD_PATHS.store, body: PRI.store });
    expect(before.status).toBe(403);
    expect(before.body.toString()).toContain(`has fetched ${SCRIPT_PATH} from this server, and 127.0.0.1 has not`);
    expect(seen.at(-1)?.detail).toContain('has not');
    // Asking for something else, or for a path that is not there, does not count.
    expect((await ask(server.port, { path: TOOL_PATHS.x64 })).status).toBe(200);
    expect((await ask(server.port, { path: '/d.ps1x' })).status).toBe(404);
    expect((await ask(server.port, { method: 'PUT', path: UPLOAD_PATHS.store, body: PRI.store })).status).toBe(403);
    expect(server.snapshot().fetchers).toEqual([]);
    expect((await ask(server.port, { path: SCRIPT_PATH })).status).toBe(200);
    expect(server.snapshot().fetchers).toEqual(['127.0.0.1']);
    expect((await ask(server.port, { method: 'PUT', path: UPLOAD_PATHS.store, body: PRI.store })).status).toBe(201);
    // The gate asks nothing of a GET.
    const open = await serve();
    expect((await ask(open.port, { method: 'PUT', path: UPLOAD_PATHS.store, body: PRI.store })).status).toBe(201);
  });

  it('stops when both have arrived, says so, hands back both, answers the last PUT first, and listens no more', async () => {
    const server = await serve();
    const first = await ask(server.port, { method: 'PUT', path: UPLOAD_PATHS.test, body: PRI.test });
    expect(first.status).toBe(201);
    const last = await ask(server.port, { method: 'PUT', path: UPLOAD_PATHS.store, body: PRI.store });
    expect(last.status).toBe(201);
    expect(last.body.toString()).toBe(`received store: ${PRI.store.length} bytes\n`);
    const outcome = await server.finished;
    expect(outcome.reason).toBe('complete');
    expect(outcome.received.store?.equals(PRI.store)).toBe(true);
    expect(outcome.received.test?.equals(PRI.test)).toBe(true);
    const refused = await new Promise<string>((done) => {
      const socket = createConnection({ host: '127.0.0.1', port: server.port });
      socket.on('connect', () => {
        socket.destroy();
        done('connected');
      });
      socket.on('error', (error: NodeJS.ErrnoException) => done(error.code ?? 'error'));
    });
    expect(refused).toBe('ECONNREFUSED');
  }, 4000);

  it('stops after the time given, with what has arrived so far', async () => {
    const server = await serve({ timeoutMs: 150 });
    expect((await ask(server.port, { method: 'PUT', path: UPLOAD_PATHS.store, body: PRI.store })).status).toBe(201);
    const outcome = await server.finished;
    expect(outcome.reason).toBe('timeout');
    expect(Object.keys(outcome.received)).toEqual(['store']);
  }, 4000);

  it('stops when told to by a signal, at once if it is already given, and drops a client that is still connected', async () => {
    const controller = new AbortController();
    const server = await serve({ signal: controller.signal });
    const socket = createConnection({ host: '127.0.0.1', port: server.port });
    socket.resume();
    // The server drops it rather than ending it politely, which the socket reports as a reset.
    socket.on('error', () => {});
    const closed = new Promise((done) => socket.on('close', done));
    await new Promise((done) => socket.on('connect', done));
    controller.abort();
    expect((await server.finished).reason).toBe('interrupted');
    await closed;
    const early = AbortSignal.abort();
    const second = await serve({ signal: early });
    const outcome = await second.finished;
    expect(outcome).toEqual({ reason: 'interrupted', received: {}, refused: {} });
  }, 4000);

  it('keeps a connection with nothing to do open longer than the 100 seconds that Windows PowerShell 5.1 reuses one for, and lets go of it after the time it is given', async () => {
    expect(KEEP_ALIVE_MS).toBeGreaterThan(100_000);
    const server = await serve({ keepAliveMs: 300 });
    // One request on a connection that stays open; the server must be the one that hangs up, after the 300 ms and not after Node's own 5 seconds.
    await new Promise<void>((done, fail) => {
      const socket = createConnection({ host: '127.0.0.1', port: server.port }, () => socket.write(`GET ${SCRIPT_PATH} HTTP/1.1\r\nHost: x\r\n\r\n`));
      socket.on('data', () => {});
      socket.on('error', fail);
      socket.on('end', () => {
        socket.destroy();
        done();
      });
    });
  }, 3000);

  it('stops on stop(), once, whatever is asked after', async () => {
    const server = await serve();
    server.stop('timeout');
    server.stop('interrupted');
    expect((await server.finished).reason).toBe('timeout');
  });

  it('tells what it did of every request, to whoever asked to know', async () => {
    const seen: string[] = [];
    const server = await serve({ observe: ({ method, path, status, client }) => seen.push(`${client} ${method} ${path} ${status}`) });
    await ask(server.port, { path: SCRIPT_PATH });
    await ask(server.port, { path: '/nope' });
    await ask(server.port, { method: 'POST', path: SCRIPT_PATH, body: 'x' });
    expect(seen).toEqual(['127.0.0.1 GET /d.ps1 200', '127.0.0.1 GET /nope 404', '127.0.0.1 POST /d.ps1 405']);
  });

  it('says the port is in use when it is, and the address is not there when it is not', async () => {
    const taken = await serve();
    expect(await rejectionOf(() => startServer({ host: '127.0.0.1', port: taken.port, routes: ROUTES, timeoutMs: 1000 }))).toMatch(/Port \d+ on 127\.0\.0\.1 is already in use/);
    // 192.0.2.1 is reserved for documentation (RFC 5737): no interface has it.
    expect(await rejectionOf(() => startServer({ host: '192.0.2.1', port: 0, routes: ROUTES, timeoutMs: 1000 }))).toMatch(/is not an address of this Mac/);
    await expect(startServer({ host: '192.0.2.1', port: 0, routes: ROUTES, timeoutMs: 1000 })).rejects.toBeInstanceOf(Failure);
  });

  it('listens on the address it is given and not on the others of this Mac', async () => {
    const server = await serve();
    // Bound to 127.0.0.1, it does not answer on the machine's other addresses.
    const others = Object.values((await import('node:os')).networkInterfaces()).flatMap((list) => list ?? []).filter((entry) => entry.family === 'IPv4' && entry.address !== '127.0.0.1');
    for (const { address } of others.slice(0, 2)) {
      const result = await new Promise<string>((done) => {
        const socket = createConnection({ host: address, port: server.port, timeout: 1500 });
        socket.on('connect', () => {
          socket.destroy();
          done('connected');
        });
        socket.on('timeout', () => {
          socket.destroy();
          done('timeout');
        });
        socket.on('error', (error: NodeJS.ErrnoException) => done(error.code ?? 'error'));
      });
      expect(result, address).not.toBe('connected');
    }
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------------

describe('an index that lists every image', () => {
  const names = assetImages().map(({ name }) => name);

  /** An index with only these image paths in it, as makepri writes them (backslashes, 8-bit), on top of what makes it a PRI file for the identity. */
  function indexWith(paths: readonly string[], form: 'ascii' | 'utf16' = 'ascii'): Buffer {
    const encode = (path: string): Buffer => Buffer.from(path, form === 'ascii' ? 'latin1' : 'utf16le');
    return Buffer.concat([sampleIndex('store').subarray(0, 8), ...paths.flatMap((path) => [encode(path), Buffer.alloc(1)])]);
  }

  it('is sampleIndex: the 60 images are all there, for either package', () => {
    expect(names).toHaveLength(60);
    for (const kind of kinds) {
      const index = sampleIndex(kind);
      expect(imagesLackingInIndex(index)).toEqual([]);
      expect(checkIndexImages(index)).toBe(index);
      expect(indexProblem(kind, index)).toBeNull();
    }
  });

  it('writes each path as makepri does: with backslashes', () => {
    expect(indexPathOf('Assets/Square44x44Logo.targetsize-24_altform-unplated.png')).toBe('Assets\\Square44x44Logo.targetsize-24_altform-unplated.png');
    expect(indexPathOf('Assets/StoreLogo.png')).toBe('Assets\\StoreLogo.png');
  });

  it('fails when a single image is missing, and names that one and no other, whichever it is', () => {
    for (const name of names) {
      const index = indexWith(names.filter((one) => one !== name).map(indexPathOf));
      expect(imagesLackingInIndex(index), name).toEqual([name]);
      expect(messageOf(() => checkIndexImages(index)), name).toContain(`it does not list 1 of the 60 images of a package (${name})`);
      expect(indexHoldsImage(index, name), name).toBe(false);
    }
  });

  it('fails an index made for an older set of images, the three plain ones that 1.3.2 had, and shows how many are lacking', () => {
    const old = indexWith(['StoreLogo', 'Square44x44Logo', 'Square150x150Logo'].map((logo) => `Assets\\${logo}.png`));
    expect(imagesLackingInIndex(old)).toHaveLength(57);
    const said = messageOf(() => checkIndexImages(old));
    expect(said).toContain('does not list 57 of the 60 images of a package');
    expect(said).toContain('and 54 more');
    expect(said).toContain('Make it again with pnpm msix:pri');
    expect(imagesLackingInIndex(Buffer.alloc(0))).toHaveLength(60);
  });

  it('looks for the path whole, with its folder and its backslash: the name alone, a forward slash or another folder do not count', () => {
    const name = 'Assets/Square44x44Logo.targetsize-24_altform-unplated.png';
    for (const wrong of ['Square44x44Logo.targetsize-24_altform-unplated.png', name, 'Assets\\sub\\Square44x44Logo.targetsize-24_altform-unplated.png'.replace('Assets\\sub', 'Other'), 'Assets\\Square44x44Logo.targetsize-24_altform-unplated.PNG']) {
      expect(indexHoldsImage(indexWith([wrong]), name), wrong).toBe(false);
    }
    expect(indexHoldsImage(indexWith([indexPathOf(name)]), name)).toBe(true);
    // Not the longer name that holds its start, and not the unplated form for the plain one.
    expect(indexHoldsImage(indexWith(['Assets\\Square44x44Logo.targetsize-24_altform-lightunplated.png']), name)).toBe(false);
    expect(indexHoldsImage(indexWith(['Assets\\Square44x44Logo.targetsize-24.png']), name)).toBe(false);
  });

  it('takes a path written in UTF-16LE too, which is how makepri would write one with a character outside ASCII', () => {
    expect(imagesLackingInIndex(indexWith(names.map(indexPathOf), 'utf16'))).toEqual([]);
    expect(imagesLackingInIndex(indexWith(names.map(indexPathOf).slice(1), 'utf16'))).toEqual([names[0]]);
  });

  // Microsoft's own resources.pri, from the MSIX Packaging SDK, if this Mac has it checked out (the README tells where): the paths in it are 8-bit.
  const sample = join(homedir(), 'msix-packaging', 'src', 'test', 'testData', 'pack', 'input');
  describe.skipIf(!existsSync(join(sample, 'resources.pri')))("read off Microsoft's own resources.pri", () => {
    it('holds the path of each file of the Assets folder that was indexed, as 8-bit text with backslashes, which is the form the check looks for', () => {
      const bytes = readFileSync(join(sample, 'resources.pri'));
      const files = readdirSync(join(sample, 'Assets'));
      expect(files).toHaveLength(7);
      for (const file of files) expect(indexHoldsImage(bytes, `Assets/${file}`), file).toBe(true);
      expect(bytes.includes(Buffer.from('Assets\\Square44x44Logo.targetsize-24_altform-unplated.png', 'latin1'))).toBe(true);
      expect(bytes.includes(Buffer.from('Assets\\Square44x44Logo.targetsize-24_altform-unplated.png', 'utf16le'))).toBe(false);
      expect(indexHoldsImage(bytes, 'Assets/Square44x44Logo.targetsize-16_altform-unplated.png')).toBe(false);
      expect(indexHoldsImage(bytes, 'Assets/Square44x44Logo.png')).toBe(false);
    });

    it('lacks, of the 60 images of the packages, all but the four that it has', () => {
      const lacking = imagesLackingInIndex(readFileSync(join(sample, 'resources.pri')));
      expect(lacking).toHaveLength(56);
      const held = names.filter((name) => !lacking.includes(name));
      expect(held).toEqual(['Assets/StoreLogo.png', 'Assets/Square44x44Logo.scale-200.png', 'Assets/Square150x150Logo.scale-200.png', 'Assets/Square44x44Logo.targetsize-24_altform-unplated.png']);
    });
  });
});

describe('what the VM sent, installed', () => {
  const pairs = { store: sampleIndex('store'), test: sampleIndex('test') };

  it('is saved to packaging/msix/<package>/resources.pri, byte for byte, where package-msix.mjs looks, with a sha256 of each', () => {
    const where = scratch();
    const result = installIndexes(pairs, { root: where });
    expect(result.problems).toEqual([]);
    expect(result.missing).toEqual([]);
    expect(result.installed.map(({ kind }) => kind)).toEqual(['store', 'test']);
    for (const kind of kinds) {
      const file = join(where, 'packaging', 'msix', kind, 'resources.pri');
      expect(readFileSync(file).equals(pairs[kind])).toBe(true);
      expect(result.installed.find((one) => one.kind === kind)).toEqual({ kind, file, bytes: pairs[kind].length, sha256: sha256(pairs[kind]), replaced: null });
      // package-msix.mjs reads it the same way, and takes it.
      expect(resourceIndexFor(kind, { env: {}, root: where, read: (path) => (existsSync(path) ? readFileSync(path) : null) })?.bytes.equals(pairs[kind])).toBe(true);
    }
    expect(readdirSync(join(where, 'packaging', 'msix', 'store'))).toEqual(['resources.pri']);
  });

  it('replaces a file that was there, and says what it replaced', () => {
    const where = scratch();
    installIndexes(pairs, { root: where });
    const again = installIndexes({ store: Buffer.concat([pairs.store, Buffer.from('more')]), test: pairs.test }, { root: where });
    expect(again.installed.find(({ kind }) => kind === 'store')?.replaced).toBe(sha256(pairs.store));
    expect(again.installed.find(({ kind }) => kind === 'test')?.replaced).toBe(sha256(pairs.test));
  });

  it('refuses the index of the other package, and saves the other one that is fine', () => {
    const where = scratch();
    const result = installIndexes({ store: pairs.test, test: pairs.test }, { root: where });
    expect(result.problems).toHaveLength(1);
    expect(result.problems[0]?.kind).toBe('store');
    expect(result.problems[0]?.message).toContain('it names the identity of the test package');
    expect(result.installed.map(({ kind }) => kind)).toEqual(['test']);
    expect(existsSync(join(where, 'packaging', 'msix', 'store'))).toBe(false);
  });

  it('refuses an index that lacks an image, made before the set changed, and saves nothing of it', () => {
    const where = scratch();
    const lacking = sampleIndex('store').toString('latin1').replace('Assets\\Square44x44Logo.targetsize-16_altform-unplated.png', 'Assets\\Square44x44Logo.targetsize-17_altform-unplated.png');
    const result = installIndexes({ store: Buffer.from(lacking, 'latin1'), test: pairs.test }, { root: where });
    expect(result.problems[0]?.message).toContain('it does not list 1 of the 60 images of a package (Assets/Square44x44Logo.targetsize-16_altform-unplated.png)');
    expect(result.installed.map(({ kind }) => kind)).toEqual(['test']);
    expect(existsSync(join(where, 'packaging', 'msix', 'store'))).toBe(false);
  });

  it('says what is missing, and creates no packaging/ at all when nothing is saved', () => {
    const where = scratch();
    const result = installIndexes({ store: Buffer.from('not an index') }, { root: where });
    expect(result.missing).toEqual(['test']);
    expect(result.problems.map(({ kind }) => kind)).toEqual(['store']);
    expect(result.installed).toEqual([]);
    expect(existsSync(join(where, 'packaging'))).toBe(false);
  });

  it('leaves no .partial file behind', () => {
    const where = scratch();
    installIndexes(pairs, { root: where });
    for (const kind of kinds) expect(readdirSync(join(where, 'packaging', 'msix', kind)).filter((name) => name.endsWith('.partial'))).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------------

describe('the script itself', () => {
  const script = join(root, 'scripts', 'make-pri.mjs');
  function node(args: string[], options: { env?: Record<string, string>; timeout?: number } = {}): { status: number | null; said: string } {
    const run = spawnSync(process.execPath, [script, ...args], { cwd: root, encoding: 'utf8', env: { ...process.env, ...options.env }, timeout: options.timeout ?? 30_000 });
    return { status: run.status, said: `${run.stdout}${run.stderr}${run.error?.message ?? ''}` };
  }

  it('prints the options with --help and exits 0, without touching anything', () => {
    const { status, said } = node(['--help']);
    expect(status, said).toBe(0);
    for (const flag of ['--dry-run', '--host', '--port', '--timeout', '--out-dir', '--tools-dir', '--sdk-version', '--dotnet']) expect(said, flag).toContain(flag);
    expect(said).toContain('pnpm msix:pri');
  });

  it('exits 1 and names the mistake on a wrong option, before any work', () => {
    const { status, said } = node(['--port', 'x']);
    expect(status).toBe(1);
    expect(said).toContain('--port must be a whole number from 1 to 65535 (got "x")');
  });

  it('says the UTM VM must be running when this Mac has not the address, and does nothing else first', () => {
    const out = scratch();
    const { status, said } = node(['--host', '192.0.2.1', '--out-dir', join(out, 'build')]);
    expect(status, said).toBe(1);
    expect(said).toContain('192.0.2.1 is not an address of this Mac');
    expect(said).toContain('start the UTM VM');
    expect(existsSync(join(out, 'build'))).toBe(false);
  });

  it('says the port is in use when it is, before any work', async () => {
    const out = scratch();
    const holder = createServer();
    await new Promise<void>((done) => holder.listen(0, '127.0.0.1', done));
    const address = holder.address();
    const port = typeof address === 'object' && address ? address.port : 0;
    try {
      const run = await new Promise<{ status: number | null; said: string }>((done) => {
        // Asynchronous, so that this process goes on answering while the script finds the port busy.
        import('node:child_process').then(({ execFile }) =>
          execFile(process.execPath, [script, '--host', '127.0.0.1', '--port', String(port), '--out-dir', join(out, 'build')], { cwd: root }, (error, stdout, stderr) => {
            done({ status: error && typeof error.code === 'number' ? error.code : 0, said: `${stdout}${stderr}` });
          }),
        );
      });
      expect(run.status, run.said).toBe(1);
      expect(run.said).toContain(`Port ${port} on 127.0.0.1 is already in use`);
      expect(existsSync(join(out, 'build'))).toBe(false);
    } finally {
      await new Promise((done) => holder.close(done));
    }
  });

  const canStage = process.platform === 'darwin' && existsSync('/usr/bin/sips');
  describe.skipIf(!canStage)('a whole --dry-run, on a Mac, with a cache of makepri made in a temporary folder', () => {
    const VERSION = '10.0.99999.1';
    let work = '';
    let result: { status: number | null; said: string } = { status: null, said: '' };
    let packagingBefore = false;
    let exes: Record<Architecture, Buffer>;

    beforeAll(() => {
      work = scratch();
      exes = keepMakepri(join(work, 'tools'), VERSION);
      packagingBefore = existsSync(join(root, 'packaging'));
      result = node(['--dry-run', '--sdk-version', VERSION, '--tools-dir', join(work, 'tools'), '--out-dir', join(work, 'out')], { timeout: 110_000 });
    }, 120_000);

    it('exits 0, and every check of the server passed', () => {
      expect(result.status, result.said).toBe(0);
      expect(result.said).not.toContain('FAIL');
      expect(result.said.match(/ PASS /g)?.length).toBeGreaterThanOrEqual(20);
      expect(result.said).toContain('PASS PUT with a Content-Length over the limit is refused with 413');
      expect(result.said).toContain('PASS the same Store index sent a second time is accepted with 200, and changes nothing');
      expect(result.said).toContain('PASS a second PUT of the Store index with other bytes is refused with 409');
      expect(result.said).toContain('PASS GET /status now says the Store index was received');
      expect(result.said).toContain('The server stopped when both files had arrived.');
    });

    it('reuses the cache without fetching anything, and says which makepri it has', () => {
      expect(result.said).toContain(`makepri ${VERSION}: kept from an earlier run`);
      expect(result.said).toContain(`${sha256(exes.arm64)}`);
      expect(result.said).toContain(`${sha256(exes.x64)}`);
      expect(result.said).not.toContain('nuget.org for the newest');
    });

    it('writes the folder of each package and d.ps1, which names the SHA-256 of what was staged', () => {
      const out = join(work, 'out');
      expect(readdirSync(out).sort()).toEqual(['d.ps1', 'dry-run-install', 'store', 'test']);
      for (const kind of kinds) {
        expect(readdirSync(join(out, kind)).sort()).toEqual(['AppxManifest.xml', 'Assets']);
        expect(readdirSync(join(out, kind, 'Assets'))).toHaveLength(60);
      }
      const text = readFileSync(join(out, 'd.ps1'), 'utf8');
      expect(text).toContain(sha256(readFileSync(join(out, 'store', 'AppxManifest.xml'))));
      expect(text).toContain(sha256(readFileSync(join(out, 'test', 'Assets', 'Square44x44Logo.targetsize-16_altform-unplated.png'))));
      expect(text).toContain(`'arm64' = '${sha256(exes.arm64)}'`);
      expect(result.said).toContain(`The script for the VM: ${join(out, 'd.ps1')}`);
      expect(readFileSync(join(out, 'store', 'AppxManifest.xml'), 'utf8')).toContain('Name="PedroMiguelRodriguesJorge.zWorkTracker"');
      expect(readFileSync(join(out, 'test', 'AppxManifest.xml'), 'utf8')).toContain('Name="rustcircle.zWorkTracker.Test"');
    });

    it('installs the made-up indexes in the build folder, and leaves packaging/ alone', () => {
      for (const kind of kinds) expect(existsSync(join(work, 'out', 'dry-run-install', 'packaging', 'msix', kind, 'resources.pri')), kind).toBe(true);
      expect(result.said).toContain('Nothing was installed in packaging/');
      expect(existsSync(join(root, 'packaging'))).toBe(packagingBefore);
    });
  });

  describe.skipIf(!canStage)('a real run, against a stand-in for the VM that asks for the files and sends the indexes back', () => {
    const VERSION = '10.0.99999.1';
    let work = '';
    let app = '';
    const pris = { store: sampleIndex('store'), test: sampleIndex('test') };

    beforeAll(() => {
      work = scratch();
      keepMakepri(join(work, 'tools'), VERSION);
      // A copy of the app with what the script reads of it, the config and the icon: what it installs goes into this copy, not into the repo.
      app = join(work, 'app');
      mkdirSync(join(app, 'src-tauri', 'icons'), { recursive: true });
      copyFileSync(join(root, 'src-tauri', 'icons', 'icon.png'), join(app, 'src-tauri', 'icons', 'icon.png'));
      writeFileSync(join(app, 'src-tauri', 'tauri.conf.json'), JSON.stringify({ productName: 'zWorkTracker', version: '1.3.3', bundle: { shortDescription: 'Labor hours tracker' } }));
    });

    /** A free port, found by listening on port 0 and letting go of it. */
    async function freePort(): Promise<number> {
      const probe = createServer();
      await new Promise<void>((done) => probe.listen(0, '127.0.0.1', done));
      const address = probe.address();
      await new Promise((done) => probe.close(done));
      return typeof address === 'object' && address ? address.port : 0;
    }

    /**
     * Runs the script for real, on 127.0.0.1 and a free port, and starts `vm` as the person in the VM would, when the line to type is printed:
     * that is the moment the server is listening, so nothing here waits a set time. Returns what the script returned and said.
     */
    async function realRun(extra: string[], vm: (port: number) => Promise<void>): Promise<{ code: number; lines: string[]; port: number }> {
      const port = await freePort();
      const lines: string[] = [];
      const stop = new AbortController();
      let started: Promise<void> | undefined;
      let patience: ReturnType<typeof setTimeout> | undefined;
      const code = await run(['--host', '127.0.0.1', '--port', String(port), '--tools-dir', join(work, 'tools'), '--sdk-version', VERSION, '--out-dir', join(work, 'out'), ...extra], {
        env: {},
        root: app,
        signal: stop.signal,
        say: (line) => {
          lines.push(line);
          if (line.trim() === vmLine('127.0.0.1', port) && !started) {
            // If the stand-in fails, the run is stopped at once, as by Ctrl-C, and the failure is what the test reports: no server is left waiting for a VM that is not coming.
            // If it succeeds and the run has not ended 10 seconds later, the server does not stop when it should: the run is stopped, and the test fails on what it said.
            started = vm(port);
            started.then(
              () => void (patience = setTimeout(() => stop.abort(), 10_000)),
              () => stop.abort(),
            );
          }
        },
      });
      clearTimeout(patience);
      await started;
      return { code, lines, port };
    }

    /** What the script on the VM does first: fetches the script and every file of both packages and both makepri.exe, each with a 200. */
    async function fetchEverything(port: number): Promise<void> {
      const paths = [SCRIPT_PATH, TOOL_PATHS.arm64, TOOL_PATHS.x64, ...kinds.flatMap((kind) => folderFiles().map((file) => `/${kind}/${file}`))];
      for (const path of paths) expect((await ask(port, { path })).status, path).toBe(200);
    }
    const put = async (port: number, kind: PackageKind, body: Buffer): Promise<number> => (await ask(port, { method: 'PUT', path: UPLOAD_PATHS[kind], body })).status;
    const installed = (kind: PackageKind): string => join(app, 'packaging', 'msix', kind, 'resources.pri');
    /** What a VM does before anything else: fetches the script. An upload is taken only from a PC that has (review finding R5). */
    const fetchScript = async (port: number): Promise<void> => {
      expect((await ask(port, { path: SCRIPT_PATH })).status).toBe(200);
    };

    it('prints the line to type, serves, takes both indexes, checks them and saves them under packaging/msix, and says what to run next', async () => {
      rmSync(join(app, 'packaging'), { recursive: true, force: true });
      const { code, lines, port } = await realRun([], async (at) => {
        await fetchEverything(at);
        expect(await put(at, 'test', pris.test)).toBe(201);
        expect(await put(at, 'store', pris.store)).toBe(201);
      });
      const said = lines.join('\n');
      expect(code, said).toBe(0);
      expect(lines).toContain(`    ${vmLine('127.0.0.1', port)}`);
      expect(said).toContain(`Serving on http://127.0.0.1:${port} until both files arrive, 15 minutes pass, or Ctrl-C.`);
      expect(said).toContain('store: all 61 files sent');
      expect(said).toContain('test: all 61 files sent');
      expect(said).toContain('The server stopped: both files arrived.');
      for (const kind of kinds) {
        expect(readFileSync(installed(kind)).equals(pris[kind]), kind).toBe(true);
        expect(readFileSync(join(work, 'out', 'received', `${kind}-resources.pri`)).equals(pris[kind]), kind).toBe(true);
        expect(said, kind).toContain(`Saved ${installed(kind)}`);
        expect(said, kind).toContain(`${pris[kind].length} bytes, SHA-256 ${sha256(pris[kind])}`);
      }
      expect(lines.at(-1)).toBe('  pnpm package:msix --identity both');
      // The script for the VM was written for review, and names this port.
      expect(readFileSync(join(work, 'out', 'd.ps1'), 'utf8')).toContain(`$base = 'http://127.0.0.1:${port}'`);
    }, 60_000);

    it('keeps the name free when it turns an upload away, so that the VM can send it again, and then takes it', async () => {
      rmSync(join(app, 'packaging'), { recursive: true, force: true });
      const { code, lines } = await realRun([], async (at) => {
        await fetchScript(at);
        const garbage = await ask(at, { method: 'PUT', path: UPLOAD_PATHS.store, body: '<html>not found</html>' });
        expect(garbage.status).toBe(422);
        expect(garbage.body.toString()).toContain('it is not a PRI file');
        expect(await put(at, 'store', pris.test)).toBe(422);
        expect(await put(at, 'store', pris.store)).toBe(201);
        expect(await put(at, 'test', pris.test)).toBe(201);
      });
      expect(code, lines.join('\n')).toBe(0);
      expect(lines.join('\n')).toContain('422');
      for (const kind of kinds) expect(readFileSync(installed(kind)).equals(pris[kind]), kind).toBe(true);
    }, 60_000);

    // Review finding R1: the VM may not manage to show why the Mac turned an index away, so the Mac says it, at once and again at the end.
    it('says on the Mac why it turned an index away, as it happens, and at the end says that one arrived and was refused, and keeps it', async () => {
      rmSync(join(app, 'packaging'), { recursive: true, force: true });
      const { code, lines } = await realRun(['--timeout', '0.05'], async (at) => {
        await fetchScript(at);
        expect(await put(at, 'store', pris.test)).toBe(422);
      });
      const said = lines.join('\n');
      expect(code, said).toBe(1);
      // While it happens: the request and, under it, the reason.
      expect(said).toMatch(/127\.0\.0\.1 PUT \/store-resources\.pri 422\n {6}refused: it names the identity of the test package, rustcircle\.zWorkTracker\.Test/);
      expect(said).toContain('store: nothing that passed; the last try, ');
      // At the end: not "no index arrived", which is false, but what was refused and where it is kept.
      expect(said).toContain('NOT saved: the VM sent an index for the store package, and it was refused: it names the identity of the test package');
      expect(said).not.toContain('NOT saved: no index arrived for the store package.');
      expect(said).toContain('NOT saved: no index arrived for the test package.');
      const kept = join(work, 'out', 'received', 'store-refused.pri');
      expect(said).toContain(`The refused file is kept in ${kept}.`);
      expect(readFileSync(kept).equals(pris.test)).toBe(true);
      expect(existsSync(join(app, 'packaging'))).toBe(false);
    }, 60_000);

    // Review finding R2: the line typed in the VM a second time, after one index was sent, sends that one again and goes on with the other.
    it('finishes when the VM sends an index again, as a line typed a second time does: the one it holds is told by /status, and the same bytes are no conflict', async () => {
      rmSync(join(app, 'packaging'), { recursive: true, force: true });
      const { code, lines } = await realRun([], async (at) => {
        await fetchScript(at);
        const before = JSON.parse((await ask(at, { path: STATUS_PATH })).body.toString()) as { pri: Record<PackageKind, unknown> };
        expect(before.pri).toEqual({ store: null, test: null });
        expect(await put(at, 'store', pris.store)).toBe(201);
        const after = JSON.parse((await ask(at, { path: STATUS_PATH })).body.toString()) as { schema: number; pri: Record<PackageKind, { bytes: number; sha256: string } | null> };
        expect(after.schema).toBe(1);
        expect(after.pri.store).toEqual({ bytes: pris.store.length, sha256: sha256(pris.store) });
        expect(after.pri.test).toBeNull();
        // The second time round: the same index again is accepted, another is not, and the test index completes the job.
        await fetchScript(at);
        expect(await put(at, 'store', pris.store)).toBe(200);
        expect(await put(at, 'store', Buffer.concat([pris.store, Buffer.from('x')]))).toBe(409);
        expect(await put(at, 'test', pris.test)).toBe(201);
      });
      expect(code, lines.join('\n')).toBe(0);
      for (const kind of kinds) expect(readFileSync(installed(kind)).equals(pris[kind]), kind).toBe(true);
      expect(lines.join('\n')).toContain('refused: The store upload was already received, and this one is not the same.');
    }, 60_000);

    // Review finding R5: nothing is taken from a PC that was not given the script.
    it('takes no index from an address that has not fetched the script, says why, and takes it from the one that has', async () => {
      rmSync(join(app, 'packaging'), { recursive: true, force: true });
      const { code, lines } = await realRun([], async (at) => {
        const stranger = await ask(at, { method: 'PUT', path: UPLOAD_PATHS.store, body: pris.store });
        expect(stranger.status).toBe(403);
        expect(stranger.body.toString()).toContain('has fetched /d.ps1 from this server');
        await fetchScript(at);
        expect(await put(at, 'store', pris.store)).toBe(201);
        expect(await put(at, 'test', pris.test)).toBe(201);
      });
      expect(code, lines.join('\n')).toBe(0);
      expect(lines.join('\n')).toContain('127.0.0.1 PUT /store-resources.pri 403');
    }, 60_000);

    // Review finding R3: a throw after the server began to listen must not leave it listening, with the process kept alive, until the time is up.
    it('stops listening when it fails after it began, and does not wait for the time to run out', async () => {
      const port = await freePort();
      const failing = run(['--host', '127.0.0.1', '--port', String(port), '--tools-dir', join(work, 'tools'), '--sdk-version', VERSION, '--out-dir', join(work, 'out'), '--timeout', '30'], {
        env: {},
        root: app,
        say: (line) => {
          if (line.startsWith('The script for the VM: ')) throw new Error('say failed on purpose');
        },
      });
      await expect(failing).rejects.toThrow('say failed on purpose');
      // Listening again on that port is possible at once.
      const again = await startServer({ host: '127.0.0.1', port, routes: new Map(), timeoutMs: 1000 });
      again.stop();
      await again.finished;
    }, 60_000);

    it('ends with what arrived when the time runs out, saves the index that is good, says the other is missing and exits 1', async () => {
      rmSync(join(app, 'packaging'), { recursive: true, force: true });
      const { code, lines } = await realRun(['--timeout', '0.05'], async (at) => {
        await fetchScript(at);
        expect(await put(at, 'store', pris.store)).toBe(201);
      });
      const said = lines.join('\n');
      expect(code, said).toBe(1);
      expect(said).toContain('The server stopped: the time ran out.');
      expect(said).toContain(`Saved ${installed('store')}`);
      expect(said).toContain('NOT saved: no index arrived for the test package.');
      expect(said).toContain('Not done: run this again once the VM step works. What was saved above is valid and stays.');
      expect(readFileSync(installed('store')).equals(pris.store)).toBe(true);
      expect(existsSync(join(app, 'packaging', 'msix', 'test'))).toBe(false);
      expect(said).not.toContain('pnpm package:msix --identity both');
    }, 60_000);

    it('saves nothing when nothing good arrives, and exits 1', async () => {
      rmSync(join(app, 'packaging'), { recursive: true, force: true });
      const { code, lines } = await realRun(['--timeout', '0.05'], async (at) => {
        await fetchScript(at);
      });
      expect(code, lines.join('\n')).toBe(1);
      expect(lines.join('\n')).toContain('NOT saved: no index arrived for the store package.');
      expect(lines.join('\n')).toContain('NOT saved: no index arrived for the test package.');
      expect(existsSync(join(app, 'packaging'))).toBe(false);
    }, 60_000);
  });
});
