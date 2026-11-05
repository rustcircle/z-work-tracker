// @vitest-environment node
// scripts/msix-vm.mjs (`pnpm msix:vm`): the command line, the certificate that signs the WACK copy (as a pure description and made for real), the signing
// and what must stay true of the package it copies and of the key, the report of the Windows App Certification Kit and the reader of its XML, the checks on
// the packages and how they are published, the PowerShell for the VM (as text: pwsh is not installed here, so it is read, not run), the rules of the server
// the VM talks to (run for real on 127.0.0.1), and the script itself: --help, the refusals, a whole --dry-run, and real runs against a stand-in for the VM
// that makes the same requests the PowerShell would. What needs a tool (openssl, osslsigncode, makemsix, sips, zip, unzip) is skipped on a machine without it.
import { spawnSync } from 'node:child_process';
import { X509Certificate, createHash } from 'node:crypto';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { createServer } from 'node:net';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { DEFAULT_HOST, DEFAULT_PORT, Failure as MakePriFailure, SCRIPT_PATH, STATUS_PATH, TOOL_PATHS, UPLOAD_PATHS, exchange, folderFiles, indexProblem, packageUrl, sampleIndex, startServer, unplatedNames, vmLine, type RunningServer } from './make-pri.mjs';
import { EXECUTABLE, assetImages, identityOf, manifestFor, type PackageKind } from './msix-manifest.mjs';
import {
  DEFAULT_TIMEOUT_MINUTES,
  EXPECTED_FAMILY,
  Failure,
  KEY_BITS,
  LINGER_MINUTES,
  REPORT_LIMIT,
  REPORT_PATH,
  SDK_FEATURE,
  SDK_INSTALLER_URL,
  SERVED_DIRECTORY,
  VM_STATUS_LIMIT,
  VM_STATUS_PATH,
  VM_UPLOAD_PATHS,
  VM_UPLOAD_RULES,
  WACK_SKEW_MINUTES,
  WACK_VALID_DAYS,
  asn1Time,
  buildMsixVmScript,
  certificateSpec,
  createWackCertificate,
  decodeXmlBytes,
  digestOf,
  findOpenssl,
  findOsslsigncode,
  formatWackReport,
  gateChecks,
  gateLines,
  helpText,
  keyMaterialIn,
  manifestIdentity,
  opensslArguments,
  packageEntries,
  packageEntry,
  parseOptions,
  parseWackReport,
  parseXml,
  publishPackages,
  readVmStatus,
  reportPasses,
  reportSummary,
  run,
  sampleWackReport,
  signTestCopy,
  signWackCopy,
  stampOf,
  testOutcome,
  uniqueDir,
  verifiedOk,
  vmStatusProblem,
  type GateCheck,
  type Linger,
} from './msix-vm.mjs';

const root = resolve(import.meta.dirname, '..');
const script = join(root, 'scripts', 'msix-vm.mjs');
const kinds: readonly PackageKind[] = ['store', 'test'];
const sha256 = (bytes: Buffer | string): string => createHash('sha256').update(bytes).digest('hex');
const UNZIP = '/usr/bin/unzip';
const ZIP = '/usr/bin/zip';
const makemsix = resolve(process.env.ZWT_MAKEMSIX || join(homedir(), 'msix-packaging', '.vs', 'bin', 'makemsix'));
const STORE_PUBLISHER = identityOf('store').publisher;

/** Whether a finder of tools finds one. */
function found(find: () => unknown): boolean {
  try {
    find();
    return true;
  } catch {
    return false;
  }
}
const haveSigning = process.platform === 'darwin' && found(() => findOpenssl()) && found(() => findOsslsigncode()) && existsSync(makemsix) && existsSync(UNZIP);
const haveRun = haveSigning && existsSync('/usr/bin/sips') && existsSync(ZIP);

/** What a call said when it threw. */
function messageOf(call: () => unknown): string {
  try {
    call();
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error('expected the call to throw');
}

/** Folders for the tests to write in, removed after the suite. */
const scratchFolders: string[] = [];
function scratch(): string {
  const folder = realpathSync(mkdtempSync(join(tmpdir(), 'zwt-msix-vm-test-')));
  scratchFolders.push(folder);
  return folder;
}
afterAll(() => {
  for (const folder of scratchFolders.splice(0)) rmSync(folder, { recursive: true, force: true });
});

/** The files named zwt-wack-* or zwt-test-sign-* in the system's temporary folder: where a key would be. */
function keyFoldersIn(folder: string): string[] {
  return readdirSync(folder).filter((name) => /^zwt-(wack|test-sign)-/.test(name));
}

/** The openssl and osslsigncode runs of a test, with the temporary folder of this process pointed at a folder of its own, so that what is left behind can be counted. */
function useOwnTempFolder(): { folder: () => string } {
  let own = '';
  let before: string | undefined;
  beforeAll(() => {
    own = scratch();
    before = process.env.TMPDIR;
    process.env.TMPDIR = own;
  });
  afterAll(() => {
    if (before === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = before;
  });
  return { folder: () => own };
}

/** Makes a package with makemsix from a manifest of `kind`, a stand-in exe and, if asked, a resources.pri; returns its path. Its name is the real one. */
function tinyPackage(dir: string, kind: PackageKind, { index = true }: { index?: boolean } = {}): string {
  const source = join(dir, `source-${kind}`);
  mkdirSync(source, { recursive: true });
  writeFileSync(join(source, 'AppxManifest.xml'), manifestFor(kind, { displayName: 'zWorkTracker', description: 'a tiny package for a test', version: '1.3.3' }));
  writeFileSync(join(source, EXECUTABLE), 'MZ stand-in');
  if (index) writeFileSync(join(source, 'resources.pri'), sampleIndex(kind));
  const file = join(dir, `zWorkTracker_1.3.3.0_x64_${kind === 'store' ? 'store' : 'test-unsigned'}.msix`);
  const lib = resolve(dirname(makemsix), '..', 'lib');
  const made = spawnSync(makemsix, ['pack', '-d', source, '-p', file], { encoding: 'utf8', env: { ...process.env, DYLD_FALLBACK_LIBRARY_PATH: lib } });
  expect(made.status, `${made.stdout}${made.stderr}`).toBe(0);
  return file;
}

// ---------------------------------------------------------------------------------------------------------------------------------------

describe('the command line', () => {
  it('has the defaults of the Mac on the UTM shared network, an hour to wait, and no folder chosen', () => {
    expect(parseOptions([])).toEqual({
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
    expect(DEFAULT_TIMEOUT_MINUTES).toBe(60);
  });

  it('takes every option as "--name value" and as "--name=value", and turns away what it does not understand', () => {
    expect(parseOptions(['--dry-run', '--port=9000', '--timeout', '5', '--out-dir', '/a', '--pri-dir=/b', '--publish-dir', '/c', '--tools-dir', '/d', '--sdk-version', '10.0.1.2', '--dotnet=/e'])).toMatchObject({
      dryRun: true,
      port: 9000,
      timeoutMinutes: 5,
      outDir: '/a',
      priDir: '/b',
      publishDir: '/c',
      toolsDir: '/d',
      sdkVersion: '10.0.1.2',
      dotnet: '/e',
    });
    expect(messageOf(() => parseOptions(['--nope']))).toContain('Unknown argument: --nope');
    expect(messageOf(() => parseOptions(['--host', '0.0.0.0']))).toContain('would serve on every network');
    expect(messageOf(() => parseOptions(['--host', 'example.com']))).toContain('must be an IPv4 address');
    expect(messageOf(() => parseOptions(['--publish-dir']))).toContain('--publish-dir needs a value.');
    expect(messageOf(() => parseOptions(['--timeout', '0']))).toContain('--timeout must be a number of minutes');
    expect(parseOptions(['--help', '--nope']).help).toBe(true);
  });

  it('lists every option in --help, the variables it reads, and the exit statuses', () => {
    const text = helpText();
    for (const flag of ['--dry-run', '--host', '--port', '--timeout', '--out-dir', '--pri-dir', '--publish-dir', '--tools-dir', '--sdk-version', '--dotnet', '-h, --help']) expect(text, flag).toContain(flag);
    for (const name of ['ZWT_TEST_PFX', 'ZWT_TEST_PFX_PASS_FILE', 'ZWT_OPENSSL', 'ZWT_OSSLSIGNCODE']) expect(text, name).toContain(name);
    expect(text).toContain('pnpm msix:vm');
    expect(text).toContain('Exit status: 0 when the report arrived, passed');
    expect(text).toContain('2 when the report arrived and its overall result is not PASS');
    expect(text).toContain('default 60');
  });

  it('waits for the VM to say it has finished for a few minutes after the report, longer when it installs the test package, and a little after a failure', () => {
    expect(LINGER_MINUTES).toEqual({ afterReport: 3, afterReportWithTestPackage: 15, afterFailure: 2 });
    expect(SERVED_DIRECTORY).toBe('/wack');
  });

  it('names a folder for a run by the time, and never reuses one', () => {
    expect(stampOf(new Date(2026, 10, 3, 9, 5))).toBe('20261103-0905');
    const parent = scratch();
    const first = uniqueDir(join(parent, 'runs'), '20261103-0905');
    const second = uniqueDir(join(parent, 'runs'), '20261103-0905');
    const third = uniqueDir(join(parent, 'runs'), '20261103-0905');
    expect([first, second, third].map((dir) => dir.slice(parent.length))).toEqual(['20261103-0905', '20261103-0905-2', '20261103-0905-3'].map((name) => sep + join('runs', name)));
    writeFileSync(join(first, 'kept.txt'), 'x');
    expect(readFileSync(join(first, 'kept.txt'), 'utf8')).toBe('x');
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------------

describe('the certificate for the WACK copy, as a description', () => {
  const now = new Date(Date.UTC(2026, 10, 3, 22, 30, 15, 750));
  const spec = certificateSpec({ subject: STORE_PUBLISHER, now });

  it('has exactly the Store publisher as its subject, 3072-bit RSA, and is valid for 7 days', () => {
    expect(STORE_PUBLISHER).toBe('CN=1DEF8D7B-1D68-4604-8047-048DC92CF3A9');
    expect(spec.subject).toBe('CN=1DEF8D7B-1D68-4604-8047-048DC92CF3A9');
    expect(spec.keyBits).toBe(3072);
    expect(KEY_BITS).toBe(3072);
    expect(WACK_VALID_DAYS).toBe(7);
    expect(spec.days).toBe(7);
    expect(spec.notAfter.getTime() - spec.notBefore.getTime()).toBe(7 * 24 * 3600 * 1000);
  });

  it('starts an hour before it is made, on a whole second, so that a VM whose clock is a little slow does not find it "not yet valid"', () => {
    expect(WACK_SKEW_MINUTES).toBe(60);
    expect(spec.notBefore.toISOString()).toBe('2026-11-03T21:30:15.000Z');
    expect(spec.notAfter.toISOString()).toBe('2026-11-10T21:30:15.000Z');
    expect(asn1Time(spec.notBefore)).toBe('20261103213015Z');
    expect(asn1Time(new Date(Date.UTC(2026, 0, 2, 3, 4, 5)))).toBe('20260102030405Z');
  });

  it('is good for signing code and for nothing else: digitalSignature, codeSigning, CA:FALSE, each critical, and no other extension', () => {
    expect(spec.extensions).toEqual({
      basicConstraints: 'critical,CA:FALSE',
      keyUsage: 'critical,digitalSignature',
      extendedKeyUsage: 'critical,codeSigning',
      subjectKeyIdentifier: 'hash',
    });
    expect(spec.config).toBe(
      [
        '[req]',
        'distinguished_name = dn',
        'prompt = no',
        'x509_extensions = v3_wack',
        '',
        '[dn]',
        'CN = 1DEF8D7B-1D68-4604-8047-048DC92CF3A9',
        '',
        '[v3_wack]',
        'basicConstraints = critical,CA:FALSE',
        'keyUsage = critical,digitalSignature',
        'extendedKeyUsage = critical,codeSigning',
        'subjectKeyIdentifier = hash',
        '',
      ].join('\n'),
    );
    expect(spec.config).not.toMatch(/serverAuth|clientAuth|keyCertSign|cRLSign|keyEncipherment|CA:TRUE|anyExtendedKeyUsage/);
  });

  it('is built by openssl as a self-signed SHA-256 certificate with the key not encrypted, started and ended on the dates it names, and with a subject from the configuration file only', () => {
    const args = opensslArguments(spec, { configFile: '/t/wack.cnf', keyFile: '/t/key.pem', certFile: '/t/cert.pem' });
    expect(args).toEqual(['req', '-x509', '-newkey', 'rsa:3072', '-noenc', '-keyout', '/t/key.pem', '-out', '/t/cert.pem', '-sha256', '-config', '/t/wack.cnf', '-extensions', 'v3_wack', '-not_before', '20261103213015Z', '-not_after', '20261110213015Z']);
    // The dates decide, and nothing else lets the subject or the key be set, or ask for a password.
    expect(args).not.toContain('-days');
    expect(args).not.toContain('-subj');
    expect(args.join(' ')).not.toMatch(/-passout|-pass |-aes|-des|-encrypt/);
  });

  it('refuses a subject that is not one plain common name, because it is written into a configuration file', () => {
    for (const subject of ['CN=a\n[v3_wack]\nbasicConstraints = CA:TRUE', 'CN=a, O=b', 'O=b', 'CN=', 'CN=a;b', 'CN=a=b', 'CN="a"', 'CN=#1', '', 'cn=a', 'CN=a\r', `CN=${'a'.repeat(70)}`]) {
      expect(messageOf(() => certificateSpec({ subject, now })), JSON.stringify(subject)).toContain('The certificate subject must be one common name');
    }
    expect(certificateSpec({ subject: 'CN=zWorkTracker Test Signing', now }).subject).toBe('CN=zWorkTracker Test Signing');
    expect(messageOf(() => certificateSpec({ subject: STORE_PUBLISHER, now, days: 0 }))).toContain('from 1 to 30');
    expect(messageOf(() => certificateSpec({ subject: STORE_PUBLISHER, now, days: 365 }))).toContain('from 1 to 30');
    expect(messageOf(() => certificateSpec({ subject: STORE_PUBLISHER, now, keyBits: 1024 }))).toContain('at least 2048 bits');
    expect(messageOf(() => certificateSpec({ subject: STORE_PUBLISHER, now, skewMinutes: -1 }))).toContain('0 to 1440 minutes');
  });

  it('reads the two lines osslsigncode verify prints, and the status it returns, and takes nothing less', () => {
    const ok = 'Signature verification: ok\n\nNumber of verified signatures: 1\nSucceeded\n';
    expect(verifiedOk(0, ok)).toBe(true);
    expect(verifiedOk(1, ok)).toBe(false);
    expect(verifiedOk(0, ok.replace('ok', 'failed'))).toBe(false);
    expect(verifiedOk(0, ok.replace('verified signatures: 1', 'verified signatures: 0'))).toBe(false);
    expect(verifiedOk(0, 'Number of verified signatures: 12\nSignature verification: ok')).toBe(false);
    expect(verifiedOk(null, ok)).toBe(false);
    // The digest the signature was made with is named in the output, and a signature with another is not taken.
    expect(digestOf('Message digest algorithm: SHA256\nAuthenticated attributes:')).toBe('SHA256');
    expect(digestOf('\tMessage digest algorithm: SHA1\n')).toBe('SHA1');
    expect(digestOf('nothing')).toBeNull();
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------------

describe.skipIf(!haveSigning)('the certificate made for real, and the copy of the Store package signed with it', () => {
  const own = useOwnTempFolder();
  const now = new Date();

  it('makes a key and a certificate that are what was described, in a folder only this user can open, and puts the files at mode 600', () => {
    const openssl = findOpenssl();
    const dir = mkdtempSync(join(own.folder(), 'zwt-wack-direct-'));
    chmodSync(dir, 0o700);
    try {
      const spec = certificateSpec({ subject: STORE_PUBLISHER, now });
      const made = createWackCertificate({ openssl, dir, spec });
      expect(made.facts).toMatchObject({ subject: STORE_PUBLISHER, keyBits: 3072, signatureAlgorithm: 'sha256WithRSAEncryption' });
      expect(made.facts.thumbprint).toMatch(/^[0-9A-F]{40}$/);
      expect(statSync(dir).mode & 0o777).toBe(0o700);
      for (const file of readdirSync(dir)) expect(statSync(join(dir, file)).mode & 0o777, file).toBe(0o600);
      expect(readFileSync(made.keyFile, 'utf8')).toMatch(/^-----BEGIN PRIVATE KEY-----/);
      // What openssl says of it, in its own words.
      const text = spawnSync(openssl.path, ['x509', '-in', made.certFile, '-noout', '-text', '-nameopt', 'RFC2253'], { encoding: 'utf8' }).stdout;
      expect(text).toContain('Public-Key: (3072 bit)');
      expect(text).toContain('Subject: CN=1DEF8D7B-1D68-4604-8047-048DC92CF3A9');
      expect(text).toMatch(/X509v3 Basic Constraints: critical\s+CA:FALSE/);
      expect(text).toMatch(/X509v3 Key Usage: critical\s+Digital Signature\s/);
      expect(text).toMatch(/X509v3 Extended Key Usage: critical\s+Code Signing\s/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('signs a copy and leaves the package as it was, byte for byte, and the copy is the package and its signature and nothing more', () => {
    const work = scratch();
    const store = tinyPackage(work, 'store');
    const before = sha256(readFileSync(store));
    const out = join(work, 'run');
    const said: string[] = [];
    const result = signWackCopy({ storePackage: store, outDir: out, now, say: (line) => said.push(line) });
    // The package that is uploaded: unsigned, and not a byte different.
    expect(sha256(readFileSync(store))).toBe(before);
    expect(result.unsignedSha256).toEqual({ before, after: before });
    expect(packageEntries(store)).not.toContain('AppxSignature.p7x');
    expect(said.join('\n')).toContain('Signature verification: ok; Number of verified signatures: 1; Message digest algorithm: SHA256');
    // The copy: named for what it is, with every file the package has and the signature.
    expect(result.signedFile).toBe(join(out, 'zWorkTracker_1.3.3.0_x64_store-wack.msix'));
    expect(packageEntries(result.signedFile).sort()).toEqual([...packageEntries(store), 'AppxSignature.p7x'].sort());
    for (const entry of ['AppxManifest.xml', 'AppxBlockMap.xml', 'resources.pri', EXECUTABLE]) expect(packageEntry(result.signedFile, entry)?.equals(packageEntry(store, entry) ?? Buffer.alloc(0)), entry).toBe(true);
    expect(sha256(readFileSync(result.signedFile))).toBe(result.signedSha256);
    // The certificate it leaves for the VM: public, a file Windows imports, and the one the copy is signed with.
    expect(result.certificateFile).toBe(join(out, 'zWorkTracker-store-wack.cer'));
    const certificate = new X509Certificate(readFileSync(result.certificateFile));
    expect(certificate.subject).toBe(STORE_PUBLISHER);
    expect(certificate.ca).toBe(false);
    expect(certificate.keyUsage).toEqual(['1.3.6.1.5.5.7.3.3']);
    expect(certificate.publicKey.asymmetricKeyDetails?.modulusLength).toBe(3072);
    expect(certificate.validToDate.getTime() - certificate.validFromDate.getTime()).toBe(7 * 24 * 3600 * 1000);
    expect(certificate.fingerprint.replaceAll(':', '')).toBe(result.certificate.thumbprint);
    expect(readFileSync(result.certificateFile).toString('latin1')).not.toContain('PRIVATE KEY');
    // Checked again, independently of the code that signed: with its own certificate as the only anchor it verifies, and with none it does not.
    const anchor = join(work, 'anchor.pem');
    writeFileSync(anchor, certificate.toString());
    const sign = findOsslsigncode().path;
    const withIt = spawnSync(sign, ['verify', '-in', result.signedFile, '-CAfile', anchor], { encoding: 'utf8' });
    expect(withIt.status, withIt.stdout).toBe(0);
    expect(withIt.stdout).toContain('Signature verification: ok');
    expect(withIt.stdout).toContain('Subject: CN=1DEF8D7B-1D68-4604-8047-048DC92CF3A9');
    expect(spawnSync(sign, ['verify', '-in', result.signedFile], { encoding: 'utf8' }).status).toBe(1);
  });

  it('deletes the private key, and the folder it was in, as soon as the copy is signed, and leaves no key anywhere it wrote', () => {
    const work = scratch();
    const store = tinyPackage(work, 'store');
    const out = join(work, 'run');
    const result = signWackCopy({ storePackage: store, outDir: out, now });
    expect(result.keyRemoved).toBe(true);
    expect(existsSync(result.keyDir)).toBe(false);
    expect(result.keyDir.startsWith(own.folder())).toBe(true);
    expect(keyFoldersIn(own.folder())).toEqual([]);
    expect(readdirSync(out).sort()).toEqual(['zWorkTracker-store-wack.cer', 'zWorkTracker_1.3.3.0_x64_store-wack.msix']);
    expect(keyMaterialIn(out)).toEqual([]);
    expect(keyMaterialIn(work).filter((file) => !file.includes('source-'))).toEqual([]);
    // The signed package carries a signature and a certificate, never a key.
    expect(readFileSync(result.signedFile).includes(Buffer.from('PRIVATE KEY'))).toBe(false);
  });

  it('deletes the key when signing fails too, and leaves no signed copy or certificate behind', () => {
    const work = scratch();
    const store = tinyPackage(work, 'store');
    const out = join(work, 'run');
    // A stand-in for osslsigncode that says what the real one says of itself and fails when asked to sign.
    const fake = join(work, 'osslsigncode-fails');
    writeFileSync(fake, '#!/bin/sh\ncase "$1" in\n  --version) echo "osslsigncode 2.14, using: stand-in"; exit 0;;\n  --help) echo "It can sign PE, CAB, CAT, MSI and APPX files"; exit 0;;\nesac\necho "no signing today" >&2\nexit 1\n');
    chmodSync(fake, 0o755);
    const message = messageOf(() => signWackCopy({ storePackage: store, outDir: out, now, env: { ...process.env, ZWT_OSSLSIGNCODE: fake } }));
    expect(message).toContain('osslsigncode could not sign zWorkTracker_1.3.3.0_x64_store.msix');
    expect(message).toContain('no signing today');
    expect(keyFoldersIn(own.folder())).toEqual([]);
    expect(existsSync(join(out, 'zWorkTracker_1.3.3.0_x64_store-wack.msix'))).toBe(false);
    expect(existsSync(join(out, 'zWorkTracker-store-wack.cer'))).toBe(false);
  });

  it('refuses a verification that does not pass, and a package that is not a package, before any key is made', () => {
    const work = scratch();
    const notAPackage = join(work, 'zWorkTracker_1.3.3.0_x64_store.msix');
    writeFileSync(notAPackage, 'not a zip');
    expect(messageOf(() => signWackCopy({ storePackage: notAPackage, outDir: join(work, 'run'), now }))).toContain('has no AppxManifest.xml with a Publisher');
    expect(keyFoldersIn(own.folder())).toEqual([]);
  });

  it('signs the copy of the test package with the owner key only when both variables are set, reads the password from its file and never shows it, and checks the subject', () => {
    const work = scratch();
    const test = tinyPackage(work, 'test');
    const out = join(work, 'run');
    mkdirSync(out);
    const secret = 'S3cret-pass-for-the-test-only';
    const openssl = findOpenssl();
    const makePfx = (name: string, common: string): { pfx: string; pass: string; thumbprint: string } => {
      const dir = join(work, name);
      mkdirSync(dir, { mode: 0o700 });
      const key = join(dir, 'key.pem');
      const cert = join(dir, 'cert.pem');
      const pass = join(dir, 'pass.txt');
      const pfx = join(dir, 'signing.pfx');
      writeFileSync(pass, secret, { mode: 0o600 });
      const made = spawnSync(openssl.path, ['req', '-x509', '-newkey', 'rsa:2048', '-noenc', '-keyout', key, '-out', cert, '-subj', `/CN=${common}`, '-days', '2'], { encoding: 'utf8' });
      expect(made.status, made.stderr).toBe(0);
      const packed = spawnSync(openssl.path, ['pkcs12', '-export', '-inkey', key, '-in', cert, '-out', pfx, '-passout', `file:${pass}`], { encoding: 'utf8' });
      expect(packed.status, packed.stderr).toBe(0);
      const thumbprint = new X509Certificate(readFileSync(cert)).fingerprint.replaceAll(':', '');
      rmSync(key);
      rmSync(cert);
      return { pfx, pass, thumbprint };
    };
    const good = makePfx('good', 'zWorkTracker Test Signing');
    const stranger = makePfx('stranger', 'Somebody Else');
    const said: string[] = [];
    const env = (pfx: string, pass: string) => ({ ...process.env, ZWT_TEST_PFX: pfx, ZWT_TEST_PFX_PASS_FILE: pass });

    // Not set, one set, or a path that is no file: nothing is signed, and it says why.
    expect(signTestCopy({ testPackage: test, outDir: out, env: {} }).skipped).toBe('ZWT_TEST_PFX and ZWT_TEST_PFX_PASS_FILE are not set');
    expect(signTestCopy({ testPackage: test, outDir: out, env: { ZWT_TEST_PFX: good.pfx } }).skipped).toBe('only ZWT_TEST_PFX is set, and both are needed');
    expect(signTestCopy({ testPackage: test, outDir: out, env: { ZWT_TEST_PFX_PASS_FILE: good.pass } }).skipped).toBe('only ZWT_TEST_PFX_PASS_FILE is set, and both are needed');
    expect(signTestCopy({ testPackage: test, outDir: out, env: env(join(work, 'none.pfx'), good.pass) }).skipped).toContain('which is not a file');
    expect(readdirSync(out)).toEqual([]);
    // The wrong password, and a key whose certificate is for another publisher.
    const wrong = join(work, 'wrong.txt');
    writeFileSync(wrong, 'not-it');
    expect(signTestCopy({ testPackage: test, outDir: out, env: env(good.pfx, wrong) }).skipped).toContain('openssl could not open');
    const mismatch = signTestCopy({ testPackage: test, outDir: out, env: env(stranger.pfx, stranger.pass) });
    expect(mismatch.skipped).toContain('"CN=Somebody Else"');
    expect(mismatch.skipped).toContain('Windows would not install it');
    expect(readdirSync(out)).toEqual([]);
    // Both set, and the key is the test package's: a copy, verified, and the original unchanged.
    const before = sha256(readFileSync(test));
    const signed = signTestCopy({ testPackage: test, outDir: out, env: env(good.pfx, good.pass), say: (line) => said.push(line) });
    if (signed.signedFile === undefined) throw new Error(`the test package was not signed: ${signed.skipped}`);
    expect(signed.signedFile).toBe(join(out, 'zWorkTracker_1.3.3.0_x64_test-signed.msix'));
    expect(signed.signerThumbprint).toBe(good.thumbprint);
    expect(signed.signerSubject).toBe('CN=zWorkTracker Test Signing');
    expect(packageEntries(signed.signedFile)).toContain('AppxSignature.p7x');
    expect(sha256(readFileSync(test))).toBe(before);
    expect(said.join('\n')).toContain('Signature verification: ok');
    expect(keyFoldersIn(own.folder())).toEqual([]);
    // The password is in no line that was said, no result, no argument that was logged, and no file that was written.
    expect(said.join('\n')).not.toContain(secret);
    expect(JSON.stringify(signed)).not.toContain(secret);
    expect(JSON.stringify(mismatch)).not.toContain(secret);
    for (const name of readdirSync(out)) expect(readFileSync(join(out, name)).includes(Buffer.from(secret)), name).toBe(false);
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------------

describe('the report of the Windows App Certification Kit', () => {
  // The shape is read off a real report, a public gist of the Servo project's from 2020 (gist.github.com/jdm/97674e9c83de6c8f1617a519996a379d): REPORT with
  // OVERALL_RESULT and the attributes below, REQUIREMENTS > REQUIREMENT[NUMBER, TITLE] > TEST[INDEX, NAME, DESCRIPTION, EXECUTIONTIME, OPTIONAL] with MESSAGES >
  // MESSAGE[TEXT] and RESULT in a CDATA section, then thousands of elements of what the kit saw of the package. sampleWackReport makes one in that shape.
  const failing = sampleWackReport({ failing: true });
  const passing = sampleWackReport();

  it('is in the shape of the real one: the attributes, the requirements, the tests, the messages, a CDATA result, and a long tail that is not read', () => {
    expect(failing).toContain('<REPORT xml:lang="en-US" OVERALL_RESULT="FAIL" VERSION="10.0.28000.2957"');
    expect(failing).toContain('TOOLSET_ARCHITECTURE="x64"');
    expect(failing).toContain('<REQUIREMENT NUMBER="15" TITLE="Supported API test"');
    expect(failing).toContain('<TEST INDEX="38" NAME="Supported APIs" DESCRIPTION="Windows Store App must only use supported platform APIs." EXECUTIONTIME="00h:00m:01s.00ms" OPTIONAL="FALSE">');
    expect(failing).toContain('<RESULT><![CDATA[FAIL]]></RESULT>');
    expect(failing).toContain('<MESSAGES />');
    expect(failing).toContain('<DEPENDENCY_INFORMATION>');
    expect(failing).toMatch(/^[\x09\x0a\x20-\x7e]+$/);
  });

  it('reads the overall result, the counts, and every test with its outcome, requirement, and the text of what it found', () => {
    const report = parseWackReport(failing);
    expect(report.overall).toBe('FAIL');
    expect(report.attributes).toMatchObject({ VERSION: '10.0.28000.2957', TOOLSET_ARCHITECTURE: 'x64', APP_NAME: 'zWorkTracker', PARTIAL_RUN: 'FALSE', OSVERSION: '10.0.28000.0' });
    expect(report.counts).toEqual({ PASS: 5, FAIL: 1, WARN: 2, UNKNOWN: 0 });
    expect(report.tests).toHaveLength(8);
    expect(report.requirements.map(({ number, title }) => `${number} ${title}`)).toEqual(['10 Deployment and launch tests', '12 Package compliance test', '15 Supported API test', '19 App manifest resources tests', '25 Package sanity test']);
    const apis = report.tests.find(({ name }) => name === 'Supported APIs');
    expect(apis).toMatchObject({ index: '38', optional: false, rawResult: 'FAIL', outcome: 'FAIL' });
    expect(apis?.messages).toEqual([
      'API Module32FirstW in kernel32.dll is not supported for this application type. zWorkTracker.exe calls this API.',
      'API Module32NextW in kernel32.dll is not supported for this application type. zWorkTracker.exe calls this API.',
    ]);
    expect(report.tests.find(({ name }) => name === 'App launch')).toMatchObject({ outcome: 'PASS', messages: [] });
    expect(reportPasses(report)).toBe(false);
  });

  it('shows an optional test that failed as a warning, as the kit does, and a result of WARN as one too; neither changes the overall result', () => {
    const report = parseWackReport(passing);
    expect(report.overall).toBe('PASS');
    expect(report.counts).toEqual({ PASS: 6, FAIL: 0, WARN: 2, UNKNOWN: 0 });
    const blocked = report.tests.find(({ name }) => name === 'Blocked executables');
    expect(blocked).toMatchObject({ optional: true, rawResult: 'FAIL', outcome: 'WARN' });
    expect(report.tests.find(({ name }) => name === 'Digitally signed files')).toMatchObject({ optional: true, rawResult: 'WARN', outcome: 'WARN' });
    expect(report.problems).toEqual([]);
    expect(reportPasses(report)).toBe(true);
    expect(testOutcome('PASS', false)).toBe('PASS');
    expect(testOutcome('FAIL', false)).toBe('FAIL');
    expect(testOutcome('FAIL', true)).toBe('WARN');
    expect(testOutcome(' warning ', false)).toBe('WARN');
    expect(testOutcome('PASS', true)).toBe('PASS');
    for (const odd of ['', 'SKIPPED', 'NOT RUN', 'PASSED', 'FAILED', null, undefined]) expect(testOutcome(odd, false), String(odd)).toBe('UNKNOWN');
  });

  it('shows what it does not understand, never counts it as a pass, and notes what does not add up', () => {
    const odd = parseWackReport(passing.replace('<RESULT><![CDATA[PASS]]></RESULT>', '<RESULT><![CDATA[SKIPPED]]></RESULT>'));
    expect(odd.counts.UNKNOWN).toBe(1);
    expect(odd.problems.join(' ')).toContain('1 test(s) have a result that is neither PASS, FAIL nor WARN');
    expect(reportPasses(odd)).toBe(false);
    expect(formatWackReport(odd).join('\n')).toContain('UNKNOWN');
    // PASS overall with a required test that failed, and FAIL overall with none, are both said.
    const liar = parseWackReport(failing.replace('OVERALL_RESULT="FAIL"', 'OVERALL_RESULT="PASS"'));
    expect(liar.problems.join(' ')).toContain('the overall result is PASS but 1 required test(s) failed');
    expect(reportPasses(liar)).toBe(false);
    const odder = parseWackReport(passing.replace('OVERALL_RESULT="PASS"', 'OVERALL_RESULT="FAIL"'));
    expect(odder.problems.join(' ')).toContain('the overall result is FAIL but no required test failed');
    expect(reportPasses(odder)).toBe(false);
    expect(parseWackReport(passing.replace(' OVERALL_RESULT="PASS"', '')).problems.join(' ')).toContain('states no overall result');
    const partial = parseWackReport(passing.replace('PARTIAL_RUN="FALSE"', 'PARTIAL_RUN="TRUE"'));
    expect(partial.problems.join(' ')).toContain('not every test was run');
    expect(partial.partial).toBe(true);
    expect(reportPasses(partial)).toBe(false);
    // The kit says in an attribute when it ran the tests on the files only, which it does when it cannot install the package.
    const files = parseWackReport(passing.replace('PARTIAL_RUN="FALSE"', 'PARTIAL_RUN="FALSE" FileOnlyTests="True"'));
    expect(files.problems.join(' ')).toContain('FileOnlyTests is TRUE: the kit ran the tests on the files only');
    expect(parseWackReport(passing.replace('PARTIAL_RUN="FALSE"', 'PARTIAL_RUN="FALSE" FileOnlyTests="False"')).problems).toEqual([]);
    expect(parseWackReport('<REPORT OVERALL_RESULT="PASS"><REQUIREMENTS /></REPORT>').problems.join(' ')).toContain('holds no test');
  });

  it('reads the attributes and elements whatever the case of their names, as PowerShell does for Analyze-Results.ps1', () => {
    const lower = passing.replace(/ INDEX=/g, ' Index=').replace(/ NAME=/g, ' Name=').replace(/ OPTIONAL=/g, ' Optional=').replace('OVERALL_RESULT=', 'Overall_Result=');
    const report = parseWackReport(lower);
    expect(report.overall).toBe('PASS');
    expect(report.counts.WARN).toBe(2);
    expect(report.tests[0]?.name).toBe('App launch');
  });

  it('prints the overall result first, then each test with PASS, FAIL or WARN and, for the ones that did not pass, what it checks and what it found', () => {
    const lines = formatWackReport(parseWackReport(failing));
    expect(lines[0]).toBe('Windows App Certification Kit: overall result FAIL');
    expect(lines).toContain('  kit 10.0.28000.2957, x64, Microsoft Windows 11 Pro 10.0.28000.0');
    expect(lines).toContain('  8 tests: 5 PASS, 1 FAIL, 2 WARN (an optional test that failed, which the overall result does not count), 0 not understood');
    expect(lines).toContain('    PASS   [47] App launch');
    expect(lines).toContain('    FAIL   [38] Supported APIs');
    expect(lines).toContain('        what it checks: Windows Store App must only use supported platform APIs.');
    expect(lines).toContain('        - API Module32FirstW in kernel32.dll is not supported for this application type. zWorkTracker.exe calls this API.');
    expect(lines).toContain('    WARN   optional [92] Blocked executables');
    expect(lines).toContain('        - File WebView2Loader.dll references the string "cmd".');
    // A test that passed has no messages under it.
    expect(lines.indexOf('    PASS   [47] App launch') + 1).toBe(lines.indexOf('    PASS   [21] Crashes and hangs'));
    // The messages are cut to a number and a length, and say that there are more.
    const many = failing.replace('<MESSAGE TEXT="API Module32NextW', Array.from({ length: 10 }, (_, number) => `<MESSAGE TEXT="extra ${number}" />`).join('') + '<MESSAGE TEXT="API Module32NextW');
    const cut = formatWackReport(parseWackReport(many), { maxMessages: 3, maxLength: 30 });
    // 3 of the 12 messages of the test that failed, and the one message of each of the two warnings.
    expect(cut.filter((line) => line.startsWith('        - '))).toHaveLength(3 + 1 + 1);
    expect(cut.join('\n')).toMatch(/\.\.\. and \d+ more messages in the report/);
  });

  it('puts what the VM sent on one line each, with no control character, whatever the report says', () => {
    const evil = failing.replace('Module32FirstW in kernel32.dll', 'Module32FirstW&#27;[2J in kernel32.dll&#10;second line');
    const lines = formatWackReport(parseWackReport(evil));
    expect(lines.join('\n')).not.toContain('\x1b');
    expect(lines.some((line) => line.includes('Module32FirstW [2J in kernel32.dll second line'))).toBe(true);
  });

  it('is written as a summary for the folder of the run: JSON with the counts, the problems and every test', () => {
    const report = parseWackReport(failing);
    const summary = reportSummary(report, { file: '/x/wack-report.xml', sha256: sha256(failing), bytes: failing.length }) as { overall: string; passes: boolean; counts: unknown; requirements: { tests: { name: string; outcome: string; messages: string[] }[] }[] };
    expect(summary).toMatchObject({ schema: 1, overall: 'FAIL', passes: false, counts: { PASS: 5, FAIL: 1, WARN: 2, UNKNOWN: 0 }, sha256: sha256(failing) });
    expect(summary.requirements.flatMap(({ tests }) => tests).find(({ name }) => name === 'Supported APIs')).toMatchObject({ outcome: 'FAIL', messages: expect.arrayContaining([expect.stringContaining('Module32FirstW')]) });
    expect(JSON.parse(JSON.stringify(summary))).toEqual(summary);
  });

  it('reads a report in UTF-16 or UTF-8 with a byte order mark, and says what a file that is not a report is', () => {
    const utf16 = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(passing.replace('encoding="utf-8"', 'encoding="utf-16"'), 'utf16le')]);
    expect(parseWackReport(utf16).counts).toEqual({ PASS: 6, FAIL: 0, WARN: 2, UNKNOWN: 0 });
    const swapped = Buffer.concat([Buffer.from([0xfe, 0xff]), Buffer.from(passing, 'utf16le').swap16()]);
    expect(decodeXmlBytes(swapped)).toBe(passing);
    expect(parseWackReport(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(passing)])).overall).toBe('PASS');
    expect(parseWackReport(Buffer.from(passing)).overall).toBe('PASS');
    expect(messageOf(() => parseWackReport('<html><body>not found</body></html>'))).toContain('its first element is <html> and not <REPORT>');
    expect(() => parseWackReport('not xml at all')).toThrow(Failure);
    expect(() => parseWackReport('')).toThrow(/no element/);
    expect(Failure).toBe(MakePriFailure);
  });
});

describe('the reader of XML that the report is read with', () => {
  it('reads elements, attributes with either quote, text, entities, CDATA, comments and the declaration', () => {
    const root = parseXml(`<?xml version="1.0"?><!-- c --><a x="1 &gt; 0" y='it&apos;s'><b>one &amp; two &#65;&#x42;</b><c/><d><![CDATA[<raw> & ]]></d><e t="a>b"/></a>`);
    expect(root.name).toBe('a');
    expect(root.attrs).toEqual({ x: '1 > 0', y: "it's" });
    expect(root.children.map(({ name }) => name)).toEqual(['b', 'c', 'd', 'e']);
    expect(root.children[0]?.text).toBe('one & two AB');
    expect(root.children[2]?.text).toBe('<raw> & ');
    expect(root.children[3]?.attrs).toEqual({ t: 'a>b' });
  });

  it('refuses what it cannot be sure of: a DOCTYPE, tags that do not match, text outside the root, two roots, a tag with something else in it', () => {
    const bad = (text: string): string => messageOf(() => parseXml(text));
    expect(bad('<!DOCTYPE a [<!ENTITY x "y">]><a/>')).toContain('a DOCTYPE or another declaration is not accepted');
    expect(bad('<a><b></a></b>')).toContain('</a> closes <b>');
    expect(bad('<a></a></a>')).toContain('closes nothing');
    expect(bad('<a>')).toContain('<a> is not closed');
    expect(bad('text<a/>')).toContain('text outside the root element');
    expect(bad('<a/><b/>')).toContain('second root element');
    expect(bad('<a b="1" c></a>')).toContain('has something that is not an attribute');
    expect(bad('<a')).toContain('a tag is not closed');
    expect(bad('<a><!-- no end </a>')).toContain('a comment is not closed');
    expect(bad('<a><![CDATA[ no end</a>')).toContain('a CDATA section is not closed');
    expect(bad('<>')).toContain('a tag has no name');
    expect(bad('   ')).toContain('there is no element');
  });

  it('stops at a number of elements and a depth, so that a report of 5 MB cannot be a bomb', () => {
    expect(messageOf(() => parseXml(`<a>${'<b/>'.repeat(11)}</a>`, { maxNodes: 10 }))).toContain('more than 10 elements');
    expect(messageOf(() => parseXml(`${'<a>'.repeat(5)}${'</a>'.repeat(5)}`, { maxDepth: 4 }))).toContain('nested deeper than 4');
    // The real limits take the biggest report that may be sent: 5 MB of small elements.
    const big = `<REPORT>${'<AitFeature Name="kernel32.dll!X" />'.repeat(Math.floor(REPORT_LIMIT / 40))}</REPORT>`;
    expect(Buffer.byteLength(big)).toBeLessThanOrEqual(REPORT_LIMIT);
    expect(parseXml(big).children.length).toBeGreaterThan(100_000);
  });

  it('keeps an entity it does not know, and does not make a character of a number that is not one', () => {
    expect(parseXml('<a t="&nope; &#0; &#xD800; &#1114112;">&unknown;</a>').attrs.t).toBe('&nope; &#0; &#xD800; &#1114112;');
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------------

describe('the checks on a built package', () => {
  const entriesOf = (kind: PackageKind, more: string[] = []): string[] => [
    'AppxManifest.xml',
    'AppxBlockMap.xml',
    '[Content_Types].xml',
    EXECUTABLE,
    'resources.pri',
    ...assetImages().map(({ name }) => name),
    ...more,
    ...(kind === 'store' ? [] : []),
  ];
  const manifestOf = (kind: PackageKind, change: (xml: string) => string = (xml) => xml): string => change(manifestFor(kind, { displayName: 'zWorkTracker', description: 'a test', version: '1.3.3' }));
  const index = (kind: PackageKind): Buffer => sampleIndex(kind);
  const gate = (kind: PackageKind, change: Partial<Parameters<typeof gateChecks>[0]> = {}): GateCheck[] =>
    gateChecks({ kind, entries: entriesOf(kind), manifest: manifestOf(kind), indexInside: index(kind), indexExpected: index(kind), machine: 'x64', version: '1.3.3.0', ...change });
  const failedOf = (checks: GateCheck[]): string[] => checks.filter(({ ok }) => !ok).map(({ what }) => what);

  it('passes a package that has the 60 images, resources.pri at the root and the one that was saved, its identity, the version, x64, the family name, and no signature', () => {
    for (const kind of kinds) {
      const checks = gate(kind);
      expect(failedOf(checks), kind).toEqual([]);
      expect(checks.map(({ what }) => what)).toEqual([
        'Assets holds the 60 images',
        'resources.pri is at the root',
        'the resources.pri inside is the one that was saved',
        `Identity Name is ${identityOf(kind).name}`,
        `Publisher is ${identityOf(kind).publisher}`,
        'Version is 1.3.3.0',
        'ProcessorArchitecture is x64',
        'the exe is an x64 program',
        `the package family name is ${EXPECTED_FAMILY[kind]}`,
        'the package is unsigned',
      ]);
    }
    expect(EXPECTED_FAMILY).toEqual({ store: 'PedroMiguelRodriguesJorge.zWorkTracker_54k2cbaqgvhqp', test: 'rustcircle.zWorkTracker.Test_ym7m1j5c19s9r' });
    expect(assetImages()).toHaveLength(60);
  });

  it('fails a package, saying which check, for each way it can be wrong', () => {
    const images = assetImages().map(({ name }) => name);
    expect(failedOf(gate('store', { entries: entriesOf('store').filter((name) => name !== images[7]) }))).toEqual(['Assets holds the 60 images']);
    expect(failedOf(gate('store', { entries: [...entriesOf('store'), 'Assets/extra.png'] }))).toEqual(['Assets holds the 60 images']);
    expect(failedOf(gate('store', { entries: entriesOf('store').filter((name) => name !== 'resources.pri') }))).toEqual(['resources.pri is at the root']);
    expect(failedOf(gate('store', { indexInside: null }))).toEqual(['the resources.pri inside is the one that was saved']);
    expect(failedOf(gate('store', { indexInside: index('test') }))).toEqual(['the resources.pri inside is the one that was saved']);
    expect(failedOf(gate('store', { manifest: manifestOf('test') }))).toEqual(['Identity Name is PedroMiguelRodriguesJorge.zWorkTracker', 'Publisher is CN=1DEF8D7B-1D68-4604-8047-048DC92CF3A9', `the package family name is ${EXPECTED_FAMILY.store}`]);
    expect(failedOf(gate('store', { version: '1.3.4.0' }))).toEqual(['Version is 1.3.4.0']);
    expect(failedOf(gate('store', { manifest: manifestOf('store', (xml) => xml.replace('ProcessorArchitecture="x64"', 'ProcessorArchitecture="arm64"')) }))).toEqual(['ProcessorArchitecture is x64']);
    expect(failedOf(gate('store', { machine: 'arm64' }))).toEqual(['the exe is an x64 program']);
    expect(failedOf(gate('store', { machine: null }))).toEqual(['the exe is an x64 program']);
    expect(failedOf(gate('test', { entries: entriesOf('test', ['AppxSignature.p7x']) }))).toEqual(['the package is unsigned']);
    // A publisher that is not the one the family name was worked out for.
    expect(failedOf(gate('store', { manifest: manifestOf('store', (xml) => xml.replace('CN=1DEF8D7B-1D68-4604-8047-048DC92CF3A9', 'CN=Other')) }))).toContain(`the package family name is ${EXPECTED_FAMILY.store}`);
  });

  it('lays the checks out one to a line, and a failed one gets its reason', () => {
    const bad = gateLines('store', gate('store', { machine: 'arm64' }));
    expect(bad.ok).toBe(false);
    expect(bad.lines).toContain('  FAIL store: the exe is an x64 program (is arm64)');
    expect(bad.lines).toContain('  PASS store: Version is 1.3.3.0');
    expect(gateLines('test', gate('test')).ok).toBe(true);
  });

  it('reads the identity out of a manifest as package-msix.mjs does, with its XML escapes undone', () => {
    expect(manifestIdentity(manifestOf('store'))).toEqual({ name: 'PedroMiguelRodriguesJorge.zWorkTracker', publisher: 'CN=1DEF8D7B-1D68-4604-8047-048DC92CF3A9', publisherDisplayName: 'Pedro Miguel Rodrigues Jorge', version: '1.3.3.0', architecture: 'x64' });
    expect(manifestIdentity('<Package><Identity Name="a&amp;b" Publisher="CN=&quot;x&quot;" Version="1.0.0.0"/></Package>')).toMatchObject({ name: 'a&b', publisher: 'CN="x"', architecture: undefined });
    expect(manifestIdentity('nothing')).toEqual({ name: undefined, publisher: undefined, publisherDisplayName: undefined, version: undefined, architecture: undefined });
  });
});

describe.skipIf(!existsSync(ZIP) || !existsSync(UNZIP))('publishing the two packages', () => {
  /** A zip with the files named, each holding its own name, made with zip(1). */
  const zip = (file: string, names: string[]): void => {
    const dir = mkdtempSync(join(tmpdir(), 'zwt-zip-'));
    try {
      for (const name of names) writeFileSync(join(dir, name), `${file}:${name}`);
      mkdirSync(dirname(file), { recursive: true });
      rmSync(file, { force: true });
      const made = spawnSync(ZIP, ['-q', file, ...names], { cwd: dir, encoding: 'utf8' });
      expect(made.status, made.stderr).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };
  const names = { store: 'zWorkTracker_1.3.3.0_x64_store.msix', test: 'zWorkTracker_1.3.3.0_x64_test-unsigned.msix' } as const;
  const setup = (): { built: Record<PackageKind, string>; publish: string; lines: string[] } => {
    const work = scratch();
    const built = { store: join(work, 'built', names.store), test: join(work, 'built', names.test) };
    zip(built.store, ['AppxManifest.xml', 'resources.pri']);
    zip(built.test, ['AppxManifest.xml', 'resources.pri', 'other.txt']);
    return { built, publish: join(work, 'msix-build'), lines: [] };
  };

  it('puts the packages there under their names when there is nothing under those names, and says where', () => {
    const { built, publish } = setup();
    const published = publishPackages({ built, publishDir: publish, stamp: '20261103-2300' });
    for (const kind of kinds) {
      expect(published[kind].target).toBe(join(publish, names[kind]));
      expect(published[kind].renamed).toEqual([]);
      expect(sha256(readFileSync(published[kind].target))).toBe(published[kind].sha256);
      expect(published[kind].sha256).toBe(sha256(readFileSync(built[kind])));
    }
    expect(readdirSync(publish).sort()).toEqual([names.store, names.test]);
  });

  it('renames a package without a resources.pri that is there to ...no-pri.msix and keeps it, byte for byte, and touches nothing else in the folder', () => {
    const { built, publish } = setup();
    zip(join(publish, names.store), ['AppxManifest.xml']);
    zip(join(publish, names.test), ['AppxManifest.xml']);
    // What must stay as it is: older packages, the VM's folder, the tools, and a file nobody here made.
    zip(join(publish, 'zWorkTracker_1.3.2.0_x64_store.msix'), ['AppxManifest.xml']);
    zip(join(publish, 'zWorkTracker_1.3.1.0_x64_test-unsigned.msix'), ['AppxManifest.xml']);
    mkdirSync(join(publish, 'vm-test'), { recursive: true });
    writeFileSync(join(publish, 'vm-test', 'd.ps1'), 'not yours');
    mkdirSync(join(publish, 'tools', 'sdk-buildtools'), { recursive: true });
    writeFileSync(join(publish, 'tools', 'sdk-buildtools', 'cache.json'), '{}');
    writeFileSync(join(publish, 'notes.txt'), 'mine');
    const snapshot = (): Record<string, string> =>
      Object.fromEntries(
        ['zWorkTracker_1.3.2.0_x64_store.msix', 'zWorkTracker_1.3.1.0_x64_test-unsigned.msix', 'vm-test/d.ps1', 'tools/sdk-buildtools/cache.json', 'notes.txt'].map((name) => [name, sha256(readFileSync(join(publish, name)))]),
      );
    const untouched = snapshot();
    const old = { store: sha256(readFileSync(join(publish, names.store))), test: sha256(readFileSync(join(publish, names.test))) };
    const said: string[] = [];
    const published = publishPackages({ built, publishDir: publish, stamp: '20261103-2300', say: (line) => said.push(line) });
    expect(readdirSync(publish).sort()).toEqual([
      'notes.txt',
      'tools',
      'vm-test',
      'zWorkTracker_1.3.1.0_x64_test-unsigned.msix',
      'zWorkTracker_1.3.2.0_x64_store.msix',
      'zWorkTracker_1.3.3.0_x64_store.msix',
      'zWorkTracker_1.3.3.0_x64_store.no-pri.msix',
      'zWorkTracker_1.3.3.0_x64_test-unsigned.msix',
      'zWorkTracker_1.3.3.0_x64_test-unsigned.no-pri.msix',
    ]);
    expect(sha256(readFileSync(join(publish, 'zWorkTracker_1.3.3.0_x64_store.no-pri.msix')))).toBe(old.store);
    expect(sha256(readFileSync(join(publish, 'zWorkTracker_1.3.3.0_x64_test-unsigned.no-pri.msix')))).toBe(old.test);
    expect(sha256(readFileSync(join(publish, names.store)))).toBe(sha256(readFileSync(built.store)));
    expect(published.store.renamed).toEqual([{ from: join(publish, names.store), to: join(publish, 'zWorkTracker_1.3.3.0_x64_store.no-pri.msix'), hadIndex: false }]);
    expect(snapshot()).toEqual(untouched);
    expect(said.join('\n')).toContain('kept, not deleted');
    // It never deletes: nothing it did removed a byte of the old packages, which are renamed and still there.
    expect(readdirSync(publish).filter((name) => name.includes('no-pri'))).toHaveLength(2);
  });

  it('keeps a package that has a resources.pri as ...previous-<time>.msix, takes -2 and -3 when a name is taken, and leaves a package that is the same where it is', () => {
    const { built, publish } = setup();
    zip(join(publish, names.store), ['AppxManifest.xml', 'resources.pri', 'old.txt']);
    zip(join(publish, 'zWorkTracker_1.3.3.0_x64_store.previous-20261103-2300.msix'), ['AppxManifest.xml']);
    zip(join(publish, names.test), ['AppxManifest.xml']);
    zip(join(publish, 'zWorkTracker_1.3.3.0_x64_test-unsigned.no-pri.msix'), ['AppxManifest.xml', 'older.txt']);
    const olderNoPri = sha256(readFileSync(join(publish, 'zWorkTracker_1.3.3.0_x64_test-unsigned.no-pri.msix')));
    publishPackages({ built, publishDir: publish, stamp: '20261103-2300' });
    expect(readdirSync(publish).sort()).toEqual([
      'zWorkTracker_1.3.3.0_x64_store.msix',
      'zWorkTracker_1.3.3.0_x64_store.previous-20261103-2300-2.msix',
      'zWorkTracker_1.3.3.0_x64_store.previous-20261103-2300.msix',
      'zWorkTracker_1.3.3.0_x64_test-unsigned.msix',
      'zWorkTracker_1.3.3.0_x64_test-unsigned.no-pri-2.msix',
      'zWorkTracker_1.3.3.0_x64_test-unsigned.no-pri.msix',
    ]);
    expect(sha256(readFileSync(join(publish, 'zWorkTracker_1.3.3.0_x64_test-unsigned.no-pri.msix')))).toBe(olderNoPri);
    // Published twice, the second time changes nothing: the package there is the one.
    const again = publishPackages({ built, publishDir: publish, stamp: '20261103-2310' });
    expect(again.store.renamed).toEqual([]);
    expect(readdirSync(publish)).toHaveLength(6);
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------------

describe('the PowerShell script for the VM', () => {
  const BASE = 'http://192.168.64.1:8765';
  const LINE = vmLine('192.168.64.1', 8765);
  const files = Object.fromEntries(kinds.map((kind) => [kind, folderFiles().map((path) => ({ path, sha256: sha256(`${kind}:${path}`) }))])) as Record<PackageKind, { path: string; sha256: string }[]>;
  const tools = { arm64: sha256('arm64 makepri'), x64: sha256('x64 makepri') };
  const spec = { baseUrl: BASE, line: LINE, tools, files, unplated: unplatedNames() };
  const text = buildMsixVmScript(spec);
  /** The script without its comment lines and the lines of data, to look at the code alone. */
  const code = text
    .split('\n')
    .filter((line) => !/^\s*#/.test(line) && !/^\s*'[^']*' = '[0-9a-f]{64}'$/.test(line))
    .join('\n');
  /** The text of one function, from its `function` line to its closing brace. */
  const functionOf = (name: string): string => {
    const start = code.indexOf(`  function ${name}`);
    expect(start, `the script has a function ${name}`).toBeGreaterThanOrEqual(0);
    return code.slice(start, code.indexOf('\n  }\n', start) + 4);
  };
  /** Where the cleanup begins: the finally of the work (the helper functions have finally blocks of their own, which come before). */
  const FINALLY = '\n  } finally {\n    $cleanup = @()';
  /** The part of the script from the first occurrence of `from` to the first of `to` after it. */
  const between = (from: string, to: string): string => {
    const start = code.indexOf(from);
    expect(start, from).toBeGreaterThanOrEqual(0);
    const end = code.indexOf(to, start + from.length);
    expect(end, to).toBeGreaterThan(start);
    return code.slice(start, end);
  };

  it('is served at the same fixed path as the other script, so that the one line typed never changes, and names where it was fetched from', () => {
    expect(SCRIPT_PATH).toBe('/d.ps1');
    expect(LINE).toBe('iwr 192.168.64.1:8765/d.ps1 -UseBasicParsing | iex');
    expect(text).toContain(`# It was fetched by typing: ${LINE}`);
    expect(text).toContain(`$base = '${BASE}'`);
    expect(buildMsixVmScript({ ...spec, baseUrl: 'http://127.0.0.1:49733', line: vmLine('127.0.0.1', 49733) })).toContain("$base = 'http://127.0.0.1:49733'");
  });

  it('checks that it is run as Administrator before anything is fetched or written, and fails clearly if it is not', () => {
    const top = code.slice(code.indexOf('  $origin = (Get-Location).Path'));
    expect(top).toContain('if (-not (Test-IsAdmin)) {');
    expect(top).toContain('this PowerShell is not running as Administrator');
    expect(top).toContain('open Windows PowerShell with a right click and Run as administrator, and type the line again');
    const admin = top.indexOf('Test-IsAdmin');
    for (const later of ['New-Item', 'Get-Makepri', 'Get-MacStatus', 'Invoke-WebRequest', 'Import-Certificate', 'Invoke-Program']) expect(top.indexOf(later), later).toBeGreaterThan(admin);
    const check = functionOf('Test-IsAdmin');
    expect(check).toContain('[System.Security.Principal.WindowsIdentity]::GetCurrent()');
    expect(check).toContain('IsInRole([System.Security.Principal.WindowsBuiltInRole]::Administrator)');
    // The first thing it says to the Mac is where it runs; a failure of this check is a FAIL like any other, with the step named.
    expect(top).toContain("$state.Step = 'administrator'");
    expect(top).toContain("Send-VmStatus 'start' 'OK' $where");
  });

  it('works under C:\\zwt-test, and its other paths are the three that the job needs: the kit, the certificate store, and the packages of the PC', () => {
    expect(text).toContain("$root = 'C:\\zwt-test'");
    const paths = (code.match(/(?<![A-Za-z])[A-Za-z]:\\[^\s'")]*/g) ?? []).filter((path) => !path.startsWith('C:\\zwt-test'));
    expect(paths).toEqual([]);
    expect(code).toContain("'Windows Kits\\10\\App Certification Kit\\appcert.exe'");
    expect(code).toContain("[Environment]::GetEnvironmentVariable('ProgramFiles(x86)')");
    expect(code.match(/Cert:\\LocalMachine\\TrustedPeople/g)?.length).toBeGreaterThanOrEqual(3);
    expect(code.match(/Cert:\\[^\s'")]*/g)?.every((path) => path.startsWith('Cert:\\LocalMachine\\TrustedPeople'))).toBe(true);
    // The only deletes of a file or folder are inside the root, through functions that refuse a path outside it.
    expect(functionOf('Remove-Inside')).toContain("if (-not $full.StartsWith($root + '\\', [System.StringComparison]::OrdinalIgnoreCase)) {");
    expect(functionOf('Reset-Directory')).toContain("if (-not $full.StartsWith($root + '\\', [System.StringComparison]::OrdinalIgnoreCase)) {");
    const removes = code.split('\n').filter((line) => line.includes('Remove-Item'));
    // (One more line names the command, in the message that tells a person how to remove the certificate by hand.)
    expect(removes.filter((line) => !/LiteralPath \$full /.test(line) && !/\$cert\.Thumbprint/.test(line) && !/COULD NOT REMOVE/.test(line))).toEqual([]);
    expect(code).not.toMatch(/Set-ExecutionPolicy|Set-ItemProperty|New-ItemProperty|Remove-ItemProperty|Set-MpPreference|Add-MpPreference|SetEnvironmentVariable\('(?!ProgramFiles)|netsh|schtasks|\breg\b|HKLM|HKCU|\bsc\.exe\b|Invoke-Expression|\biex\b|Add-Type|Register-|Enable-WindowsOptionalFeature|Disable-|Restart-|Stop-Computer|Out-File|Set-Content|Add-Content/);
  });

  it('names the SHA-256 of everything it fetches from the Mac and checks it, and checks the Authenticode signature of the one thing it fetches from Microsoft', () => {
    expect(script).toBeDefined();
    const save = functionOf('Save-MacFile');
    expect(save).toMatch(/Get-Remote \(\$base \+ \$path\) \$target\s+Test-Hash \$target \$hash/);
    expect(save).toContain("$name -notmatch '^[A-Za-z0-9._-]+$'");
    expect(save).toContain("$path -notmatch '^/[A-Za-z0-9._/-]+$'");
    expect(save).toContain("$hash -notmatch '^[0-9A-Fa-f]{64}$'");
    // Every fetch from the Mac is a Get-Remote followed by a Test-Hash, except the SDK installer, which has its signature checked instead.
    expect(code.match(/^\s+Get-Remote /gm)).toHaveLength(3);
    expect(code.match(/^\s+Test-Hash /gm)).toHaveLength(3);
    expect(code.match(/Invoke-WebRequest/g)).toHaveLength(6);
    expect(code.match(/-OutFile/g)).toHaveLength(2);
  });

  it('fetches the SDK installer from the fwlink Microsoft gives for the current Windows SDK, checks size and Authenticode (Valid, signed by O=Microsoft Corporation) before it is run, and runs it with the feature of the kit alone', () => {
    expect(SDK_INSTALLER_URL).toBe('https://go.microsoft.com/fwlink/?linkid=2382519');
    expect(text).toContain("$sdkUrl = 'https://go.microsoft.com/fwlink/?linkid=2382519'");
    expect(SDK_FEATURE).toBe('OptionId.WindowsSoftwareLogoToolkit');
    expect(text).toContain("$sdkFeature = 'OptionId.WindowsSoftwareLogoToolkit'");
    expect(text).not.toContain('OptionId.WindowsAppCertificationKit');
    const install = between("$setup = Join-Path $root 'winsdksetup.exe'", "Send-VmStatus 'Windows App Certification Kit' 'OK' $appcert");
    const order = ['Invoke-WebRequest -UseBasicParsing -Uri $sdkUrl -OutFile $setup', '$size -lt 500000', 'Get-AuthenticodeSignature -FilePath $setup', "$signature.Status -ne 'Valid'", "$signer -notmatch '(^|, )O=Microsoft Corporation(,|$)'", '$arguments = ', 'Invoke-Program $setup $arguments'].map((one) => install.indexOf(one));
    expect(order.every((at) => at >= 0), JSON.stringify(order)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    // The exact flags: the one feature, quiet, no restart, no telemetry (and a log, to read when it fails).
    expect(install).toContain("$arguments = '/features ' + $sdkFeature + ' /quiet /norestart /ceip off /log ' + $log");
    expect(install).toContain("it was not run");
    expect(install).toContain('A quiet install of the Windows SDK accepts its license terms.');
    // It is installed only when appcert.exe is not there, and afterwards it must be there.
    expect(code).toContain('if (Test-Path -LiteralPath $appcert) {');
    expect(code).toContain('if (-not (Test-Path -LiteralPath $appcert)) {');
    expect(code).toContain("Write-Ok ('the Windows App Certification Kit is installed: ' + $appcert)");
    // A code that is not 0 or 3010 (restart needed) is a FAIL with the end of the installer's log.
    expect(install).toContain('if ($code -ne 0 -and $code -ne 3010) {');
    expect(functionOf('Get-LogTail')).toContain('Get-Content -LiteralPath $Path -Tail 12');
  });

  it('says what it knows of Windows on Arm64 and fails with that reason when the kit is not there after the installer, instead of waiting for it', () => {
    expect(code).toContain("$arch = $env:PROCESSOR_ARCHITECTURE");
    expect(code).toContain('if (-not [string]::IsNullOrEmpty($env:PROCESSOR_ARCHITEW6432)) { $arch = $env:PROCESSOR_ARCHITEW6432 }');
    expect(code.match(/\$arch -eq 'ARM64'/g)).toHaveLength(2);
    expect(code).toContain('Microsoft documents no Arm64 build of the kit');
    expect(code).toContain("GitHub''s windows-11-arm images have the Windows SDK with no appcert.exe either");
    expect(code).toContain('The kit has to be run on an x64 Windows PC.');
    // The wait for appcert.exe after the installer is bounded, and so is every program it runs.
    expect(code).toContain('$waited -lt 120');
    const run = functionOf('Invoke-Program');
    expect(run).toContain('while (-not $process.WaitForExit(15000)) {');
    expect(run).toContain('if ((Get-Date) -gt $limit) {');
    expect(run).toContain('$process.Kill()');
    expect(run).toContain("throw ($What + ' did not finish within ' + $Minutes + ' minutes and was stopped')");
    expect(code.match(/Invoke-Program \$/g)).toHaveLength(3);
    // Start-Process is used twice: to run a program with a limit of time, and to start the app that was installed.
    expect(code.match(/Start-Process/g)).toHaveLength(2);
  });

  it('polls the Mac every 10 seconds for at most 30 minutes, says where it is, and stops with the Mac\'s reason if the Mac says it failed', () => {
    expect(text).toContain('$pollMinutes = 30');
    const poll = between('    while ($true) {', "    Write-Ok 'the Mac has the packages ready'");
    expect(poll).toContain('$mac = Get-MacStatus');
    expect(poll).toContain("if ($null -ne $mac.error) { throw ('the Mac could not get the packages ready: ' + $mac.error) }");
    expect(poll).toContain('if ($mac.wack.ready) { break }');
    expect(poll).toContain('Start-Sleep -Seconds 10');
    expect(poll).toContain('Write-Info ($phase');
    expect(poll).toContain('if ((Get-Date) -gt $deadline) { throw');
    expect(code).toContain('$deadline = $started.AddMinutes($pollMinutes)');
  });

  it('imports the certificate into LocalMachine\\TrustedPeople, with its thumbprint noted before the import, and removes it in a finally by that thumbprint, whatever happened', () => {
    const body = between("$state.Step = 'trusting the WACK-only certificate'", "$state.Step = 'appcert.exe'");
    expect(body).toContain("Import-Certificate -FilePath $wackCertificate -CertStoreLocation 'Cert:\\LocalMachine\\TrustedPeople'");
    expect(body.indexOf('$state.Thumb = $thumb')).toBeLessThan(body.indexOf('Import-Certificate'));
    expect(body).toContain('if ($imported.Thumbprint -ne $thumb) {');
    expect(code).toContain("if ($thumb -notmatch '^[0-9A-F]{40}$') {");
    const cleanup = code.slice(code.indexOf(FINALLY));
    expect(cleanup).toContain("if ($state.Thumb -ne '') {");
    expect(cleanup).toContain('Where-Object { $_.Thumbprint -eq $state.Thumb }');
    expect(cleanup).toContain("Remove-Item -LiteralPath ($location + '\\' + $cert.Thumbprint) -Force");
    expect(cleanup).toContain("if ($still.Count -gt 0) { throw 'it is still in the store' }");
    // It says so when it cannot, with the command to do it by hand, and tells the Mac.
    expect(cleanup).toContain("COULD NOT REMOVE the certificate ' + $state.Thumb");
    expect(cleanup).toContain('Remove-Item Cert:\\LocalMachine\\TrustedPeople\\');
    expect(cleanup).toContain("Send-VmStatus 'cleanup' $endState $summary $true");
    expect(code.match(/Import-Certificate/g)).toHaveLength(1);
    // Nothing else is ever taken out of a certificate store, and the removal is in the finally and nowhere else.
    expect(code.match(/Remove-Item -LiteralPath \(\$location/g)).toHaveLength(1);
    expect(code.indexOf('Remove-Item -LiteralPath ($location')).toBeGreaterThan(code.indexOf(FINALLY));
  });

  it('removes only a package with the exact name of the Store identity, in the finally, and only when the kit was started; never the test package and never all users', () => {
    const cleanup = code.slice(code.indexOf(FINALLY));
    expect(cleanup).toContain('if ($state.Wack) {');
    // What the finally removes is found by one line, and checked by another: both look for the exact name, so that neither can reach another package.
    expect(cleanup).toContain('$left = @(Get-AppxPackage -Name $storeName | Where-Object { $_.Name -eq $storeName })');
    expect(cleanup).toContain('$after = @(Get-AppxPackage -Name $storeName | Where-Object { $_.Name -eq $storeName })');
    // Every lookup of an installed package in the script (not the Get-AppxPackageManifest of the one just installed) is by an exact name: -Name takes wildcards, so each is
    // filtered again with -eq, and no lookup is a bare Get-AppxPackage, which would be every package on the PC. The fifth is the message that tells a person how to remove it by hand.
    const lookups = code.split('\n').filter((line) => /Get-AppxPackage(?!Manifest)/.test(line));
    expect(lookups).toHaveLength(5);
    for (const line of lookups) {
      expect(line, line).toMatch(/Get-AppxPackage -Name \$(storeName|testName) \| Where-Object \{ \$_\.Name -eq \$\1 \}|remove it with: Get-AppxPackage -Name ' \+ \$storeName \+ ' \| Remove-AppxPackage/);
    }
    expect(cleanup).toContain('Remove-AppxPackage -Package $package.PackageFullName');
    expect(code.match(/Remove-AppxPackage -Package/g)).toHaveLength(1);
    // The other mentions are in messages that tell a person how to do it by hand.
    const mentions = code.split('\n').filter((line) => line.includes('Remove-AppxPackage') && !line.includes('Remove-AppxPackage -Package'));
    expect(mentions).toHaveLength(2);
    for (const line of mentions) expect(line, line).toMatch(/throw \(|\$line = /);
    expect(code.indexOf('Remove-AppxPackage -Package')).toBeGreaterThan(code.indexOf(FINALLY));
    expect(text).toContain("$storeName = 'PedroMiguelRodriguesJorge.zWorkTracker'");
    expect(code).not.toMatch(/-AllUsers/);
    // The test identity is named in two places only: to find the package it installs, and to check it.
    expect(text).toContain("$testName = 'rustcircle.zWorkTracker.Test'");
    expect(code.match(/\$testName/g)).toHaveLength(4);
    expect(cleanup).not.toContain('$testName');
    // It does not remove what was there before it ran: it refuses to start the kit if a package with the Store identity is installed already.
    const before = between('$present = @(Get-AppxPackage', '$state.Thumb = $thumb');
    expect(before).toContain('if ($present.Count -gt 0) {');
    expect(before).toContain('removing it would delete its data');
    expect(code.indexOf('$present = @(')).toBeLessThan(code.indexOf('Import-Certificate'));
    expect(code.indexOf('$state.Wack = $true')).toBeGreaterThan(code.indexOf('$present = @('));
  });

  it('runs appcert.exe reset and then test on the WACK copy, with the report in its own folder, and sends the report with a PUT', () => {
    const kit = between("$state.Step = 'appcert.exe'", "$state.Step = 'sending the report'");
    expect(kit).toContain("Invoke-Program $appcert 'reset' 5 'appcert.exe reset' $true");
    expect(kit).toContain("$testArguments = 'test -appxpackagepath ' + $wackPackage + ' -reportoutputpath ' + $report");
    expect(kit.indexOf("'reset'")).toBeLessThan(kit.indexOf('$testArguments'));
    expect(kit).toContain("$report = Join-Path $root 'wack-report.xml'");
    expect(kit).toContain('Invoke-Program $appcert $testArguments $wackMinutes');
    expect(kit).toContain('and wrote no report at');
    expect(text).toContain('$wackMinutes = 45');
    expect(code).toContain("$wackPackage = Save-MacFile $mac.wack.package");
    expect(code).toContain('Invoke-WebRequest -UseBasicParsing -Uri ($base + $reportPath) -Method Put -InFile $report -ContentType \'application/xml\'');
    expect(text).toContain("$reportPath = '/wack-report.xml'");
    expect(code.indexOf('Invoke-WebRequest -UseBasicParsing -Uri ($base + $reportPath)')).toBeGreaterThan(code.indexOf('$testArguments'));
  });

  it('tells the Mac its step and, at the first failure, the reason: a FAIL line, a status PUT with the step, and a last status from the finally', () => {
    const send = functionOf('Send-VmStatus');
    expect(send).toContain("Invoke-WebRequest -UseBasicParsing -Uri ($base + $vmStatusPath) -Method Put -Body $bytes -ContentType 'application/json; charset=utf-8'");
    expect(send).toContain('[System.Text.Encoding]::UTF8.GetBytes((ConvertTo-Json -InputObject $note -Compress))');
    expect(send).toContain('if ($Detail.Length -gt 6000) { $Detail = $Detail.Substring(0, 6000) }');
    expect(send).toMatch(/\} catch \{\s+Write-Info \('\(could not tell the Mac: '/);
    expect(text).toContain("$vmStatusPath = '/vm-status.json'");
    const failure = code.slice(code.indexOf('  } catch {\n    $state.Failed = $true'), code.indexOf(FINALLY));
    expect(failure).toContain("Write-Host ('FAIL [' + $state.Step + '] ' + $reason) -ForegroundColor Red");
    expect(failure).toContain("Send-VmStatus $state.Step 'FAIL' $reason");
    expect(failure).toContain('$global:LASTEXITCODE = 1');
    expect(code).toContain("$state.Step = '");
    expect(code.match(/\$state\.Step = /g)?.length).toBeGreaterThanOrEqual(10);
    // Stopped at the first FAIL: everything is in one try, and the only catch of the work is the one that reports.
    expect(code.match(/\n  \} catch \{/g)).toHaveLength(1);
    expect(code).not.toMatch(/^\s*exit(\s|$)/m);
  });

  it('makes the x64 makepri the default on every PC, as the other script does, and skips what the Mac already holds', () => {
    const choice = [
      "    $makepri = Get-Makepri 'x64'",
      '    $probe = Get-StartResult $makepri',
      '    if ($probe.Started) {',
      "      Write-Ok 'makepri x64'",
      '    } else {',
      '      $reasonX64 = $probe.Why',
      "      $makepri = Get-Makepri 'arm64'",
    ].join('\n');
    expect(code).toContain(choice);
    expect(code.indexOf(choice)).toBeLessThan(code.indexOf('foreach ($kind in $kinds) {'));
    expect(code).toContain("if ($null -ne $mac.pri.$kind) {");
    expect(code).toContain('the Mac already has its resources.pri, so it is not made again');
    expect(code).toContain("$state.Step = 'resources.pri'");
  });

  it('installs the signed test package only when the Mac made one, checks that its signer is trusted, upgrades with -ForceUpdateFromAnyVersion, starts it by its app id, and says what to look at', () => {
    const test = between('    if ($null -ne $mac.testPackage) {', "    $state.Step = 'finished'");
    expect(test).toContain('$testFile = Save-MacFile $mac.testPackage');
    expect(test).toContain("Where-Object { $_.Thumbprint -eq $testSigner }");
    expect(test).toContain('Add-AppxPackage -Path $testFile -ForceUpdateFromAnyVersion');
    expect(test.indexOf('$trusted.Count -eq 0')).toBeLessThan(test.indexOf('Add-AppxPackage'));
    expect(test).toContain('if ($package.PackageFamilyName -ne $testFamily) {');
    expect(test).toContain('$manifest = $package | Get-AppxPackageManifest');
    expect(test).toContain("Start-Process -FilePath ('shell:AppsFolder\\' + $package.PackageFamilyName + '!' + $appId)");
    expect(test).toContain('the logo should have NO plate behind it');
    expect(test).toContain('the tray icon, by the clock');
    expect(test).toContain('Import it as for the earlier test packages');
    // It does not import the test certificate itself: only the WACK-only one is ever put in the store.
    expect(test).not.toContain('Import-Certificate');
    expect(text).toContain("$testFamily = 'rustcircle.zWorkTracker.Test_ym7m1j5c19s9r'");
  });

  it('is Windows PowerShell 5.1: strict, quiet, in a scriptblock of its own, with no param block, nothing PowerShell 7 has, and plain ASCII', () => {
    expect(code).toContain('Set-StrictMode -Version Latest');
    expect(code).toContain("$ErrorActionPreference = 'Stop'");
    expect(code).toContain("$ProgressPreference = 'SilentlyContinue'");
    expect(text.replace(/^(#.*\n)+/, '').startsWith('& {\n')).toBe(true);
    expect(text.endsWith('}\n')).toBe(true);
    expect(code).not.toMatch(/\bparam\s*\(|\$PSScriptRoot|\$MyInvocation|\$PSCommandPath|\$script:/);
    expect(code).not.toMatch(/&&|\|\||\?\?|\?\.|\?\[|-Parallel|-AsHashtable|-SkipHttpErrorCheck|-AsByteStream|utf8NoBOM|\bpwsh\b|-Depth/);
    expect(code).not.toMatch(/ \? .* : /);
    expect(code).not.toMatch(/`|\$\{/);
    expect(text).toMatch(/^[\x09\x0a\x20-\x7e]+$/);
    expect(text).not.toMatch(/\r/);
    expect(code).toContain('-UseBasicParsing');
    expect(code.match(/Invoke-WebRequest/g)?.every(() => true)).toBe(true);
    for (const line of code.split('\n').filter((one) => /Invoke-WebRequest/.test(one))) expect(line, line).toContain('-UseBasicParsing');
  });

  it('leaves the shell it is typed in as it was and reports a failure by FAIL and $LASTEXITCODE, never by closing the window', () => {
    expect(code).toContain('$origin = (Get-Location).Path');
    expect(code).toContain('Set-Location -LiteralPath $origin');
    expect(code).toContain('$global:LASTEXITCODE = 0');
    expect(code).toContain('$global:LASTEXITCODE = 1');
    expect(code).toContain("Write-Host ('OK   ' + $Text) -ForegroundColor Green");
  });

  it('has quotes, braces, parentheses and brackets that match, and no string that runs past its line', () => {
    const stack: string[] = [];
    const pairs: Record<string, string> = { '}': '{', ')': '(', ']': '[' };
    let quote: string | null = null;
    text.split('\n').forEach((raw, number) => {
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
    for (const piece of text.match(/"[^"\n]*"/g) ?? []) expect(piece).not.toMatch(/[$`]/);
  });

  it('refuses anything that could end a quote or add a command, wherever the Mac puts a value in', () => {
    const bad = (change: Partial<typeof spec>): string => messageOf(() => buildMsixVmScript({ ...spec, ...change }));
    expect(bad({ baseUrl: "http://192.168.64.1:8765'; Remove-Item C:\\ #" })).toContain('baseUrl is not');
    expect(bad({ line: 'iwr x\n& { evil }' })).toContain('not plain enough');
    expect(bad({ tools: { ...tools, x64: 'not a hash' } })).toContain('a SHA-256 is not plain enough');
    expect(bad({ unplated: ["a.png'; evil; '"] })).toContain('an image name is not plain enough');
    expect(bad({ files: { ...files, test: [] } })).toContain('There are no files for the test package');
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------------

describe('what the server takes from the VM', () => {
  const served = { body: Buffer.from('# the script\n'), type: 'text/plain; charset=utf-8' };
  const routes = new Map([[SCRIPT_PATH, served]]);
  const running: RunningServer<keyof typeof VM_UPLOAD_PATHS>[] = [];
  afterEach(async () => {
    for (const server of running.splice(0)) {
      server.stop();
      await server.finished;
    }
  });
  async function serve(): Promise<RunningServer<keyof typeof VM_UPLOAD_PATHS>> {
    const server = await startServer<keyof typeof VM_UPLOAD_PATHS>({
      host: '127.0.0.1',
      port: 0,
      routes,
      uploads: VM_UPLOAD_PATHS,
      // As the run has it: an index is checked as one, and the report and the status have their own rules.
      validate: (kind, bytes) => (kind === 'store' || kind === 'test' ? indexProblem(kind, bytes) : null),
      rules: VM_UPLOAD_RULES,
      isComplete: () => false,
      peerGate: SCRIPT_PATH,
      timeoutMs: 30_000,
    });
    running.push(server);
    // As the VM does first.
    expect((await exchange(server, { path: SCRIPT_PATH })).status).toBe(200);
    return server;
  }
  const put = (server: { host: string; port: number }, path: string, body: Buffer | string | undefined, headers?: Record<string, string>) => exchange(server, { method: 'PUT', path, body, headers });
  const note = (state: string, step = 'a step', more: object = {}): string => JSON.stringify({ schema: 1, step, state, detail: 'text', ...more });

  it('takes a PUT for four names and no other: the two indexes, the report and the status, by their exact paths', async () => {
    expect(VM_UPLOAD_PATHS).toEqual({ store: '/store-resources.pri', test: '/test-resources.pri', report: '/wack-report.xml', status: '/vm-status.json' });
    expect(REPORT_PATH).toBe('/wack-report.xml');
    expect(VM_STATUS_PATH).toBe('/vm-status.json');
    const server = await serve();
    const others = ['/other.xml', '/wack-report.xml/', '/WACK-report.xml', '/wack-report.xml.bak', '/wack-report.xml%00', '/%77ack-report.xml', '//wack-report.xml', '/wack/../wack-report.xml', '/vm-status.json/', '/vm-status.JSON', '/status', '/wack-report', '/wack/zWorkTracker.msix', '/d.ps1x'];
    for (const path of others) {
      const answer = await put(server, path, Buffer.from('<REPORT/>'));
      expect([404, 405], path).toContain(answer.status);
      expect(answer.status, path).not.toBe(201);
    }
    // /status is a thing that is only read; the report and the status are only written.
    expect((await put(server, STATUS_PATH, 'x')).status).toBe(404);
    for (const path of [REPORT_PATH, VM_STATUS_PATH]) expect((await exchange(server, { path })).status, path).toBe(405);
    expect(server.snapshot().received).toEqual({});
  });

  /** A PUT whose body is sent in chunks, with no Content-Length, so that the server learns the size only by counting. */
  const putChunked = (server: { host: string; port: number }, path: string, chunks: Buffer[]): Promise<number> =>
    new Promise((done, fail) => {
      const request = httpRequest({ host: server.host, port: server.port, method: 'PUT', path, agent: false }, (response) => {
        response.resume();
        response.on('end', () => done(response.statusCode ?? 0));
      });
      request.on('error', fail);
      request.setHeader('Transfer-Encoding', 'chunked');
      for (const chunk of chunks) request.write(chunk);
      request.end();
    });

  it('takes a report of at most 5 MB, refuses one a byte over (by its Content-Length at once, or when chunks add up), and keeps one that cannot be read, to be looked at', async () => {
    expect(REPORT_LIMIT).toBe(5 * 1024 * 1024);
    const server = await serve();
    expect((await put(server, REPORT_PATH, undefined, { 'Content-Length': String(REPORT_LIMIT + 1) })).status).toBe(413);
    const exact = Buffer.alloc(REPORT_LIMIT, 0x61);
    expect((await put(server, REPORT_PATH, exact)).status).toBe(201);
    expect(server.snapshot().received.report?.length).toBe(REPORT_LIMIT);
    // Once: the same again is no conflict, another is.
    expect((await put(server, REPORT_PATH, exact)).status).toBe(200);
    expect((await put(server, REPORT_PATH, Buffer.from('<REPORT/>'))).status).toBe(409);
    // In chunks, exactly the limit is taken, and a byte more is not.
    const second = await serve();
    const half = Buffer.alloc(REPORT_LIMIT / 2, 0x62);
    expect(await putChunked(second, REPORT_PATH, [half, half, Buffer.alloc(1, 0x62)])).toBe(413);
    expect(second.snapshot().received.report).toBeUndefined();
    expect(await putChunked(second, REPORT_PATH, [half, half])).toBe(201);
    expect(second.snapshot().received.report?.length).toBe(REPORT_LIMIT);
    // Not a report at all: kept all the same (the Mac reads it when it has it), and nothing in the server looks at it.
    const third = await serve();
    expect((await put(third, REPORT_PATH, Buffer.from('<html>not found</html>'))).status).toBe(201);
    expect(third.snapshot().received.report?.toString()).toBe('<html>not found</html>');
  });

  it('takes a status of at most 64 KB that is JSON with a step and a state, refuses the rest with the reason in the answer, and lets each replace the one before', async () => {
    expect(VM_STATUS_LIMIT).toBe(64 * 1024);
    const server = await serve();
    expect((await put(server, VM_STATUS_PATH, undefined, { 'Content-Length': String(VM_STATUS_LIMIT + 1) })).status).toBe(413);
    const padded = (size: number): Buffer => {
      const base = note('OK');
      return Buffer.from(note('OK', 'a step', { pad: 'x'.repeat(size - base.length - ',"pad":""'.length) }));
    };
    expect(padded(VM_STATUS_LIMIT).length).toBe(VM_STATUS_LIMIT);
    expect((await put(server, VM_STATUS_PATH, padded(VM_STATUS_LIMIT))).status).toBe(201);
    expect((await put(server, VM_STATUS_PATH, padded(VM_STATUS_LIMIT + 1))).status).toBe(413);
    for (const [body, why] of [
      ['plain text', 'it is not JSON'],
      ['[1]', 'it is not a JSON object'],
      ['null', 'it is not a JSON object'],
      [JSON.stringify({ state: 'OK' }), 'it has no step'],
      [JSON.stringify({ step: '', state: 'OK' }), 'it has no step'],
      [JSON.stringify({ step: 'x'.repeat(121), state: 'OK' }), 'it has no step'],
      [note('MAYBE'), 'its state is not OK, FAIL or INFO'],
      [JSON.stringify({ step: 'a', state: 'OK', detail: 5 }), 'its detail is not text'],
      [JSON.stringify({ step: 'a', state: 'OK', final: 'yes' }), 'its final is not true or false'],
    ] as const) {
      const answer = await put(server, VM_STATUS_PATH, body);
      expect(answer.status, body).toBe(422);
      expect(answer.body.toString(), body).toContain(why);
    }
    // Each one that passes replaces the one before; the last is what is kept.
    expect((await put(server, VM_STATUS_PATH, note('INFO', 'first'))).status).toBe(201);
    expect((await put(server, VM_STATUS_PATH, note('FAIL', 'second', { final: true }))).status).toBe(201);
    expect(readVmStatus(server.snapshot().received.status ?? Buffer.alloc(0))).toEqual({ step: 'second', state: 'FAIL', detail: 'text', final: true, at: '', computer: '' });
    expect(vmStatusProblem('status', Buffer.from(note('OK')))).toBeNull();
    expect(vmStatusProblem('status', Buffer.from(note('OK', 'a', { at: '2026-11-03T22:00:00', computer: 'VM', final: false })))).toBeNull();
  });

  it('shows a status as one line of plain text, whatever the VM put in it', () => {
    const view = readVmStatus(Buffer.from(JSON.stringify({ step: 'a\x1b[31mstep\nline', state: 'FAIL', detail: 'reason\r\nwith\tcontrols\u0007', at: '2026-11-03T22:00:00', computer: 'WIN-1', final: true })));
    expect(view).toEqual({ step: 'a [31mstep line', state: 'FAIL', detail: 'reason with controls', final: true, at: '2026-11-03T22:00:00', computer: 'WIN-1' });
  });

  it('takes the indexes as the other script does (checked, 2 MB, the reason in the answer) and nothing from an address that has not fetched the script', async () => {
    const server = await serve();
    const refused = await put(server, UPLOAD_PATHS.store, sampleIndex('test'));
    expect(refused.status).toBe(422);
    expect(refused.body.toString()).toContain('it names the identity of the test package');
    expect((await put(server, UPLOAD_PATHS.store, sampleIndex('store'))).status).toBe(201);
    expect(server.snapshot().refused.store?.problem).toBeUndefined();
    // A second server, whose gate has not been opened by a GET of the script.
    const closed = await startServer<keyof typeof VM_UPLOAD_PATHS>({ host: '127.0.0.1', port: 0, routes, uploads: VM_UPLOAD_PATHS, rules: VM_UPLOAD_RULES, isComplete: () => false, peerGate: SCRIPT_PATH, timeoutMs: 30_000 });
    running.push(closed);
    for (const path of Object.values(VM_UPLOAD_PATHS)) expect((await put(closed, path, 'x')).status, path).toBe(403);
    expect(closed.snapshot().received).toEqual({});
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------------

describe('the script itself', () => {
  function node(args: string[], options: { env?: Record<string, string>; timeout?: number } = {}): { status: number | null; said: string } {
    const result = spawnSync(process.execPath, [script, ...args], { cwd: root, encoding: 'utf8', env: { ...process.env, ...options.env }, timeout: options.timeout ?? 30_000 });
    return { status: result.status, said: `${result.stdout}${result.stderr}${result.error?.message ?? ''}` };
  }

  it('prints the options with --help and exits 0, and is the script that "pnpm msix:vm" runs', () => {
    const { status, said } = node(['--help']);
    expect(status, said).toBe(0);
    expect(said).toBe(`${helpText()}\n`);
    const manifest: unknown = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
    expect(manifest).toMatchObject({ scripts: { 'msix:vm': 'node scripts/msix-vm.mjs', 'msix:pri': 'node scripts/make-pri.mjs' } });
  });

  it('exits 1 and names the mistake on a wrong option, before any work', () => {
    const { status, said } = node(['--port', 'x']);
    expect(status).toBe(1);
    expect(said).toContain('--port must be a whole number from 1 to 65535 (got "x")');
  });

  it('says the UTM VM must be running when this Mac has not the address, and the port is busy when it is, and does nothing else first', async () => {
    const out = scratch();
    const absent = node(['--host', '192.0.2.1', '--out-dir', join(out, 'runs')]);
    expect(absent.status, absent.said).toBe(1);
    expect(absent.said).toContain('192.0.2.1 is not an address of this Mac');
    expect(absent.said).toContain('start the UTM VM');
    expect(existsSync(join(out, 'runs'))).toBe(false);
    const holder = createServer();
    await new Promise<void>((done) => holder.listen(0, '127.0.0.1', done));
    const address = holder.address();
    const port = typeof address === 'object' && address ? address.port : 0;
    try {
      const busy = await new Promise<{ status: number; said: string }>((done) => {
        import('node:child_process').then(({ execFile }) =>
          execFile(process.execPath, [script, '--host', '127.0.0.1', '--port', String(port), '--out-dir', join(out, 'runs')], { cwd: root }, (error, stdout, stderr) => {
            done({ status: error && typeof error.code === 'number' ? error.code : 0, said: `${stdout}${stderr}` });
          }),
        );
      });
      expect(busy.status, busy.said).toBe(1);
      expect(busy.said).toContain(`Port ${port} on 127.0.0.1 is already in use by another program. Stop that program, or pick another port with --port`);
      expect(existsSync(join(out, 'runs'))).toBe(false);
    } finally {
      await new Promise((done) => holder.close(done));
    }
  });

  /** A stand-in cache of makepri, as make-pri.test.ts makes one, so that nothing is fetched. */
  function keepMakepri(toolsDir: string, version: string): Record<'arm64' | 'x64', Buffer> {
    const dir = join(toolsDir, version);
    mkdirSync(dir, { recursive: true });
    const exes = { arm64: Buffer.from('MZ arm64 makepri stand-in'), x64: Buffer.from('MZ x64 makepri stand-in') };
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

  describe.skipIf(!haveRun)('a whole --dry-run, on a Mac, with a cache of makepri made in a temporary folder', () => {
    const VERSION = '10.0.99999.1';
    let work = '';
    let result: { status: number | null; said: string } = { status: null, said: '' };
    let packagingBefore = false;
    let homeBefore = '';
    const homeListing = (): string => (existsSync(join(homedir(), 'msix-build')) ? readdirSync(join(homedir(), 'msix-build')).sort().join('|') : '(none)');

    beforeAll(() => {
      work = scratch();
      keepMakepri(join(work, 'tools'), VERSION);
      packagingBefore = existsSync(join(root, 'packaging'));
      homeBefore = homeListing();
      result = node(['--dry-run', '--sdk-version', VERSION, '--tools-dir', join(work, 'tools'), '--out-dir', join(work, 'out')], { timeout: 170_000 });
    }, 180_000);

    it('exits 0, and every check passed', () => {
      expect(result.status, result.said).toBe(0);
      expect(result.said).not.toMatch(/^\s+FAIL /m);
      expect(result.said.match(/^\s+PASS /gm)?.length).toBeGreaterThanOrEqual(40);
      expect(result.said).toContain('Dry run done: nothing was published in ~/msix-build, nothing was installed in packaging/, and no key material is left.');
    });

    it('rebuilds both packages with the indexes, gates them, and publishes them by renaming the earlier ones, in the run\'s own folder and never in ~/msix-build', () => {
      expect(result.said).toContain('Checking the packages (60 images, resources.pri at the root');
      expect(result.said.match(/^\s+PASS (store|test): /gm)).toHaveLength(20);
      expect(result.said).toMatch(/renamed .*zWorkTracker_1\.3\.3\.0_x64_store\.msix\n\s+to .*zWorkTracker_1\.3\.3\.0_x64_store\.no-pri\.msix/);
      expect(result.said).toMatch(/renamed .*zWorkTracker_1\.3\.3\.0_x64_test-unsigned\.msix\n\s+to .*zWorkTracker_1\.3\.3\.0_x64_test-unsigned\.no-pri\.msix/);
      expect(homeListing()).toBe(homeBefore);
      expect(existsSync(join(root, 'packaging'))).toBe(packagingBefore);
    });

    it('makes the certificate, signs the copy, verifies it, shows the subject and the hash of the package before and after, and deletes the key', () => {
      expect(result.said).toContain('Certificate for the WACK copy (made for this run');
      expect(result.said).toContain('CN=1DEF8D7B-1D68-4604-8047-048DC92CF3A9, RSA 3072, sha256WithRSAEncryption, valid ');
      expect(result.said).toContain('key usage digitalSignature (critical), extended key usage codeSigning (critical), CA:FALSE (critical)');
      expect(result.said).toMatch(/osslsigncode \d+\.\d+ verify \(against that certificate\): Signature verification: ok; Number of verified signatures: 1/);
      const same = /unsigned and untouched: SHA-256 ([0-9a-f]{64}) before, ([0-9a-f]{64}) after\./.exec(result.said);
      expect(same?.[1]).toBeDefined();
      expect(same?.[1]).toBe(same?.[2]);
      expect(result.said).toMatch(/The private key was deleted with its folder, \S+ \(gone: true\)\./);
      expect(result.said).toContain('PASS no key material left in ');
      expect(result.said).toMatch(/PASS the folder that held the private key is gone/);
    });

    it('serves, asks and refuses as the VM and a stranger would, and parses and prints the sample report', () => {
      expect(result.said).toContain('PASS PUT of a report with a Content-Length over 5 MB is refused with 413');
      expect(result.said).toContain('PASS PUT of a VM status with a Content-Length over 64 KB is refused with 413');
      expect(result.said).toContain('PASS the VM sends the sample report: kept (201), the same again is 200');
      expect(result.said).toContain('Windows App Certification Kit: overall result PASS');
      expect(result.said).toContain('    WARN   optional [92] Blocked executables');
      expect(result.said).toContain('PASS the sample report was read: overall PASS with 2 warnings');
    });

    it('leaves in the folder of the run what a person needs and no key: the log, the script, the WACK copy and its certificate, the report and its summary', () => {
      const runs = readdirSync(join(work, 'out'));
      expect(runs).toHaveLength(1);
      const folder = join(work, 'out', runs[0] ?? '');
      expect(readdirSync(folder).sort()).toEqual(
        ['d.ps1', 'dry-run-install', 'msix-build', 'msix-vm.log', 'packages', 'vm-files', 'vm-status-history.jsonl', 'vm-status.json', 'wack-report.xml', 'wack-summary.json', 'wack-summary.txt', 'zWorkTracker-store-wack.cer', 'zWorkTracker_1.3.3.0_x64_store-wack.msix'].sort(),
      );
      expect(keyMaterialIn(folder)).toEqual([]);
      expect(readFileSync(join(folder, 'msix-vm.log'), 'utf8')).toContain('Dry run done');
      expect(JSON.parse(readFileSync(join(folder, 'wack-summary.json'), 'utf8'))).toMatchObject({ overall: 'PASS', passes: true, counts: { WARN: 2 } });
      expect(readFileSync(join(folder, 'wack-report.xml'), 'utf8')).toBe(sampleWackReport());
      expect(readFileSync(join(folder, 'd.ps1'), 'utf8')).toContain('$base = \'http://127.0.0.1:');
      // The unsigned Store package in the (temporary) place it was published is not the WACK copy, and is unsigned.
      expect(packageEntries(join(folder, 'msix-build', 'zWorkTracker_1.3.3.0_x64_store.msix'))).not.toContain('AppxSignature.p7x');
      expect(packageEntries(join(folder, 'zWorkTracker_1.3.3.0_x64_store-wack.msix'))).toContain('AppxSignature.p7x');
      expect(statSync(join(folder, 'zWorkTracker-store-wack.cer')).size).toBeGreaterThan(500);
    });
  });

  describe.skipIf(!haveRun)('a real run, against a stand-in for the VM that makes the requests the PowerShell makes', () => {
    const VERSION = '10.0.99999.1';
    const SECRET = 'S3cret-pass-for-the-test-only';
    let work = '';
    let app = '';
    let target = '';
    let pfx = { file: '', pass: '' };
    const pris = { store: sampleIndex('store'), test: sampleIndex('test') };
    const quickly: Linger = { afterReport: 0.004, afterReportWithTestPackage: 0.004, afterFailure: 0.004 };

    /** The exe of the app, as far as the script looks: a PE header that says x64, and the ProductVersion the build puts in. */
    function standInExe(version: string): Buffer {
      const header = Buffer.alloc(0x100);
      header.write('MZ', 0, 'latin1');
      header.writeUInt32LE(0x40, 0x3c);
      header.write('PE\0\0', 0x40, 'latin1');
      header.writeUInt16LE(0x8664, 0x44);
      return Buffer.concat([header, Buffer.from('ProductVersion\0', 'utf16le'), Buffer.from(`${version}\0`, 'utf16le'), Buffer.alloc(32, 0xff)]);
    }

    beforeEach(() => {
      // Each run starts as the first: no index saved in the copy of the app.
      rmSync(join(app, 'packaging'), { recursive: true, force: true });
    });

    beforeAll(() => {
      work = scratch();
      keepMakepri(join(work, 'tools'), VERSION);
      app = join(work, 'app');
      mkdirSync(join(app, 'src-tauri', 'icons'), { recursive: true });
      copyFileSync(join(root, 'src-tauri', 'icons', 'icon.png'), join(app, 'src-tauri', 'icons', 'icon.png'));
      writeFileSync(join(app, 'src-tauri', 'tauri.conf.json'), JSON.stringify({ productName: 'zWorkTracker', version: '1.3.3', bundle: { shortDescription: 'Labor hours tracker' } }));
      target = join(work, 'target');
      const release = join(target, 'x86_64-pc-windows-gnu', 'release');
      mkdirSync(release, { recursive: true });
      writeFileSync(join(release, EXECUTABLE), standInExe('1.3.3'));
      writeFileSync(join(release, 'WebView2Loader.dll'), 'stand-in');
      // The owner's test key, as a throwaway: a .pfx for the test package's publisher, and a file with its password.
      const keys = join(work, 'keys');
      mkdirSync(keys, { mode: 0o700 });
      const openssl = findOpenssl().path;
      spawnSync(openssl, ['req', '-x509', '-newkey', 'rsa:2048', '-noenc', '-keyout', join(keys, 'k.pem'), '-out', join(keys, 'c.pem'), '-subj', '/CN=zWorkTracker Test Signing', '-days', '2']);
      writeFileSync(join(keys, 'pass.txt'), SECRET, { mode: 0o600 });
      const packed = spawnSync(openssl, ['pkcs12', '-export', '-inkey', join(keys, 'k.pem'), '-in', join(keys, 'c.pem'), '-out', join(keys, 'test.pfx'), '-passout', `file:${join(keys, 'pass.txt')}`], { encoding: 'utf8' });
      expect(packed.status, packed.stderr).toBe(0);
      rmSync(join(keys, 'k.pem'));
      pfx = { file: join(keys, 'test.pfx'), pass: join(keys, 'pass.txt') };
    }, 60_000);

    interface Item {
      name: string;
      path: string;
      bytes: number;
      sha256: string;
    }
    interface Mac {
      schema: number;
      phase: string;
      error: string | null;
      pri: Record<PackageKind, unknown>;
      packages: { store: { file: string; sha256: string }; test: { file: string; sha256: string } } | null;
      wack: { ready: boolean; package: Item | null; certificate: (Item & { thumbprint: string; subject: string }) | null };
      testPackage: (Item & { signerThumbprint: string; signerSubject: string }) | null;
      report: { bytes: number; sha256: string } | null;
      vm: { step: string; state: string } | null;
    }

    /** The folder of a run (there is one in `out`) and what is in it. */
    const runFolder = (out: string): string => join(out, readdirSync(out).sort().at(-1) ?? '');

    interface Plan {
      /** The report to send, or null to send none. */
      report?: string | null;
      /** A step to stop at, with the reason, as the PowerShell does after a FAIL. */
      failAt?: { step: string; detail: string } | null;
      /** Whether to send the last status, the one the finally sends. */
      final?: boolean;
      /** Whether to send the two indexes (a VM that failed at its first step does not). */
      indexes?: boolean;
      /** What the stand-in did, for the test to look at. */
      seen?: { mac?: Mac; wackVerified?: boolean; testDownloaded?: boolean };
    }

    /** What the PowerShell does, request for request, from the line typed to the last status. */
    async function playVm(port: number, plan: Plan): Promise<void> {
      const where = { host: '127.0.0.1', port };
      const seen = plan.seen ?? {};
      const ask = (path: string) => exchange(where, { path });
      const put = (path: string, body: Buffer | string) => exchange(where, { method: 'PUT', path, body });
      const status = (state: string, step: string, detail: string, final = false) => put(VM_STATUS_PATH, JSON.stringify({ schema: 1, step, state, detail, final, at: '2026-11-03T22:00:00', computer: 'STAND-IN' }));
      expect((await ask(SCRIPT_PATH)).status).toBe(200);
      await status('OK', 'start', 'stand-in for Windows 11 Arm64');
      if (plan.failAt) {
        await status('FAIL', plan.failAt.step, plan.failAt.detail);
        if (plan.final !== false) await status('FAIL', 'cleanup', 'nothing was added to this PC that needed taking away', true);
        return;
      }
      if (plan.indexes !== false) {
        for (const path of [`/store/AppxManifest.xml`, `/test/AppxManifest.xml`, TOOL_PATHS.x64]) expect((await ask(path)).status).toBe(200);
        expect((await put(UPLOAD_PATHS.store, pris.store)).status).toBe(201);
        expect((await put(UPLOAD_PATHS.test, pris.test)).status).toBe(201);
      }
      let mac = JSON.parse((await ask(STATUS_PATH)).body.toString()) as Mac;
      for (let at = 0; !mac.wack.ready && mac.error === null && at < 600; at++) {
        await new Promise((done) => setTimeout(done, 200));
        mac = JSON.parse((await ask(STATUS_PATH)).body.toString()) as Mac;
      }
      seen.mac = mac;
      if (mac.error !== null) {
        await status('FAIL', 'waiting for the Mac', `the Mac could not get the packages ready: ${mac.error}`);
        await status('FAIL', 'cleanup', 'nothing was added to this PC that needed taking away', true);
        return;
      }
      expect(mac.wack.ready).toBe(true);
      // The WACK copy and its certificate, each checked against the SHA-256 /status gave; then the copy verified against the certificate, as nobody on the VM can, to see the files that are served work.
      const fetched: Record<string, Buffer> = {};
      for (const item of [mac.wack.package, mac.wack.certificate, mac.testPackage]) {
        if (item === null) continue;
        const answer = await ask(item.path);
        expect(answer.status, item.path).toBe(200);
        expect(sha256(answer.body), item.path).toBe(item.sha256);
        expect(answer.body.length, item.path).toBe(item.bytes);
        fetched[item.name] = answer.body;
      }
      const downloads = join(work, `downloads-${port}`);
      mkdirSync(downloads);
      const pkg = join(downloads, mac.wack.package?.name ?? 'none.msix');
      writeFileSync(pkg, fetched[mac.wack.package?.name ?? ''] ?? Buffer.alloc(0));
      const anchor = join(downloads, 'anchor.pem');
      writeFileSync(anchor, new X509Certificate(fetched[mac.wack.certificate?.name ?? ''] ?? Buffer.alloc(0)).toString());
      const verified = spawnSync(findOsslsigncode().path, ['verify', '-in', pkg, '-CAfile', anchor], { encoding: 'utf8' });
      seen.wackVerified = verified.status === 0;
      seen.testDownloaded = mac.testPackage !== null;
      await status('INFO', 'appcert.exe', 'the test has started');
      if (plan.report !== null) {
        expect((await put(REPORT_PATH, plan.report ?? sampleWackReport())).status).toBe(201);
        await status('OK', 'report', 'the report was sent');
      }
      if (mac.testPackage !== null) await status('OK', 'test package', 'installed and started');
      if (plan.final !== false) await status('OK', 'cleanup', 'the WACK-only certificate was removed from TrustedPeople; the package the kit installed was removed', true);
    }

    /** Stand-ins for the packages published before the indexes, and files that must not be touched, in a folder to publish into. Returns the SHA-256 of what must stay. */
    function seed(publish: string): Record<string, string> {
      mkdirSync(publish, { recursive: true });
      const zip = (name: string): void => {
        const dir = mkdtempSync(join(tmpdir(), 'zwt-zip-'));
        try {
          writeFileSync(join(dir, 'AppxManifest.xml'), name);
          spawnSync(ZIP, ['-q', join(publish, name), 'AppxManifest.xml'], { cwd: dir });
        } finally {
          rmSync(dir, { recursive: true, force: true });
        }
      };
      for (const name of ['zWorkTracker_1.3.3.0_x64_store.msix', 'zWorkTracker_1.3.3.0_x64_test-unsigned.msix', 'zWorkTracker_1.3.2.0_x64_store.msix']) zip(name);
      mkdirSync(join(publish, 'vm-test'));
      writeFileSync(join(publish, 'vm-test', 'd.ps1'), 'not yours');
      return Object.fromEntries(['zWorkTracker_1.3.2.0_x64_store.msix', 'vm-test/d.ps1'].map((name) => [name, sha256(readFileSync(join(publish, name)))]));
    }

    interface Outcome {
      code: number;
      lines: string[];
      said: string;
      out: string;
      folder: string;
      publish: string;
      untouched: Record<string, string>;
    }

    /**
     * One real run on 127.0.0.1 and a free port, with the stand-in started when the line to type is printed (that is the moment the server listens, so nothing
     * waits a set time), as make-pri.test.ts does it. `seeded` puts stand-ins for the earlier packages in the folder to publish into first.
     */
    async function realRun(extra: string[], plan: Plan, options: { env?: Record<string, string>; linger?: Linger; seeded?: boolean; target?: string; plain?: boolean } = {}): Promise<Outcome> {
      const probe = createServer();
      await new Promise<void>((done) => probe.listen(0, '127.0.0.1', done));
      const address = probe.address();
      await new Promise((done) => probe.close(done));
      const port = typeof address === 'object' && address ? address.port : 0;
      const out = join(work, `out-${port}`);
      const publish = join(work, `publish-${port}`);
      const untouched = options.seeded ? seed(publish) : {};
      const lines: string[] = [];
      const stop = new AbortController();
      let started: Promise<void> | undefined;
      let patience: ReturnType<typeof setTimeout> | undefined;
      const code = await run(['--host', '127.0.0.1', '--port', String(port), '--tools-dir', join(work, 'tools'), '--sdk-version', VERSION, '--out-dir', out, '--pri-dir', join(work, `vm-files-${port}`), '--publish-dir', publish, ...extra], {
        env: { ...process.env, CARGO_TARGET_DIR: options.target ?? target, ZWT_MSIX_PRI_STORE: '', ZWT_MSIX_PRI_TEST: '', ZWT_TEST_PFX: '', ZWT_TEST_PFX_PASS_FILE: '', ...options.env },
        root: app,
        signal: stop.signal,
        linger: options.linger ?? quickly,
        say: (line) => {
          lines.push(line);
          if (line.trim() === vmLine('127.0.0.1', port) && !started) {
            // If the stand-in fails, the run is stopped as by Ctrl-C and the failure is what the test reports; if it succeeds and the run has not ended 20 seconds later, it is stopped and the test fails on what it said.
            started = playVm(port, plan);
            started.then(
              () => void (patience = setTimeout(() => stop.abort(), 20_000)),
              () => stop.abort(),
            );
          }
        },
      });
      clearTimeout(patience);
      await started;
      const said = lines.join('\n');
      return { code, lines, said, out, folder: existsSync(out) ? runFolder(out) : '', publish, untouched };
    }

    it('does it all: saves the indexes, packs, gates and publishes (renaming what was there), signs both copies, serves them, and prints and saves a report that failed, exiting 2', async () => {
      const plan: Plan = { report: sampleWackReport({ failing: true }), seen: {} };
      const result = await realRun([], plan, { seeded: true, env: { ZWT_TEST_PFX: pfx.file, ZWT_TEST_PFX_PASS_FILE: pfx.pass } });
      const { said, folder, publish } = result;
      expect(result.code, said).toBe(2);
      expect(said).toContain('The server stopped: the VM finished.');
      expect(said).toContain("Not a clean pass (exit status 2): the report's overall result is FAIL and 1 required test(s) failed.");
      expect(said).toContain(`To upload in Partner Center: ${join(publish, 'zWorkTracker_1.3.3.0_x64_store.msix')} (unsigned, SHA-256 `);
      // The indexes: saved where package-msix.mjs looks, and are what the VM sent.
      for (const kind of kinds) expect(readFileSync(join(app, 'packaging', 'msix', kind, 'resources.pri')).equals(pris[kind]), kind).toBe(true);
      // The packages: the earlier ones kept under a new name, the new ones with the index in them, nothing else of the folder touched.
      expect(readdirSync(publish).sort()).toEqual([
        'vm-test',
        'zWorkTracker_1.3.2.0_x64_store.msix',
        'zWorkTracker_1.3.3.0_x64_store.msix',
        'zWorkTracker_1.3.3.0_x64_store.no-pri.msix',
        'zWorkTracker_1.3.3.0_x64_test-unsigned.msix',
        'zWorkTracker_1.3.3.0_x64_test-unsigned.no-pri.msix',
      ]);
      for (const kind of kinds) expect(packageEntries(join(publish, `zWorkTracker_1.3.3.0_x64_${kind === 'store' ? 'store' : 'test-unsigned'}.msix`))).toContain('resources.pri');
      for (const [name, hash] of Object.entries(result.untouched)) expect(sha256(readFileSync(join(publish, name))), name).toBe(hash);
      expect(said).toContain('PASS store: the package family name is PedroMiguelRodriguesJorge.zWorkTracker_54k2cbaqgvhqp');
      expect(said).toContain('PASS test: the package family name is rustcircle.zWorkTracker.Test_ym7m1j5c19s9r');
      // The report as the kit made it, its summary, and what was printed of it.
      expect(readFileSync(join(folder, 'wack-report.xml'), 'utf8')).toBe(sampleWackReport({ failing: true }));
      expect(JSON.parse(readFileSync(join(folder, 'wack-summary.json'), 'utf8'))).toMatchObject({ overall: 'FAIL', passes: false, counts: { PASS: 5, FAIL: 1, WARN: 2 } });
      expect(said).toContain('Windows App Certification Kit: overall result FAIL');
      expect(said).toContain('    FAIL   [38] Supported APIs');
      expect(said).toContain('        - API Module32FirstW in kernel32.dll is not supported for this application type. zWorkTracker.exe calls this API.');
      expect(said).toContain('    WARN   optional [92] Blocked executables');
      // The files that were served verify (the stand-in checked the SHA-256 of each and verified the copy against the certificate); a test package was served because both variables were set.
      expect(plan.seen?.wackVerified).toBe(true);
      expect(plan.seen?.testDownloaded).toBe(true);
      expect(plan.seen?.mac?.wack.certificate?.subject).toBe(STORE_PUBLISHER);
      expect(plan.seen?.mac?.packages?.store.sha256).toBe(sha256(readFileSync(join(publish, 'zWorkTracker_1.3.3.0_x64_store.msix'))));
      expect(plan.seen?.mac?.testPackage?.signerSubject).toBe('CN=zWorkTracker Test Signing');
      expect(readdirSync(folder)).toContain('zWorkTracker_1.3.3.0_x64_test-signed.msix');
      expect(said).toContain('Test package signed with the key in ');
      // The Store package that is published is the unsigned one, whole, and the WACK copy is a different file.
      expect(packageEntries(join(publish, 'zWorkTracker_1.3.3.0_x64_store.msix'))).not.toContain('AppxSignature.p7x');
      expect(said).toMatch(/unsigned and untouched: SHA-256 ([0-9a-f]{64}) before, \1 after\./);
      // The VM's news was printed as it came, the last one included, and kept.
      expect(said).toContain('  VM OK   [cleanup] the WACK-only certificate was removed from TrustedPeople; the package the kit installed was removed  (the last news from the VM)');
      expect(JSON.parse(readFileSync(join(folder, 'vm-status.json'), 'utf8'))).toMatchObject({ step: 'cleanup', state: 'OK', final: true });
      expect(readFileSync(join(folder, 'vm-status-history.jsonl'), 'utf8').trim().split('\n').length).toBeGreaterThanOrEqual(5);
      // No key, and the password of the owner's key nowhere.
      expect(keyMaterialIn(folder)).toEqual([]);
      for (const name of readdirSync(folder)) if (statSync(join(folder, name)).isFile()) expect(readFileSync(join(folder, name)).includes(Buffer.from(SECRET)), name).toBe(false);
      expect(said).not.toContain(SECRET);
      expect(readFileSync(join(folder, 'msix-vm.log'), 'utf8')).toContain('Windows App Certification Kit: overall result FAIL');
    }, 120_000);

    it('says where it stopped and why, when the VM fails at its first step, exits 1, builds nothing, and waits for the VM to say it has cleaned up', async () => {
      const result = await realRun([], { failAt: { step: 'administrator', detail: 'this PowerShell is not running as Administrator' }, indexes: false });
      expect(result.code, result.said).toBe(1);
      expect(result.said).toContain('  VM FAIL [administrator] this PowerShell is not running as Administrator');
      expect(result.said).toContain('The VM stopped at the step "administrator". It cleans up after itself and then says so; waiting for that.');
      expect(result.said).toContain('Not a clean pass (exit status 1): the VM stopped at "administrator": this PowerShell is not running as Administrator; no report arrived.');
      expect(result.said).not.toContain('Packing both packages');
      expect(existsSync(join(result.folder, 'packages'))).toBe(false);
      expect(existsSync(result.publish)).toBe(false);
      expect(existsSync(join(app, 'packaging'))).toBe(false);
    }, 60_000);

    it('exits 1 when the time runs out, and says so, with no VM at all', async () => {
      const probe = createServer();
      await new Promise<void>((done) => probe.listen(0, '127.0.0.1', done));
      const address = probe.address();
      await new Promise((done) => probe.close(done));
      const port = typeof address === 'object' && address ? address.port : 0;
      const lines: string[] = [];
      const code = await run(['--host', '127.0.0.1', '--port', String(port), '--tools-dir', join(work, 'tools'), '--sdk-version', VERSION, '--out-dir', join(work, 'out-timeout'), '--pri-dir', join(work, 'vm-files-timeout'), '--publish-dir', join(work, 'publish-timeout'), '--timeout', '0.01'], {
        env: { ...process.env, CARGO_TARGET_DIR: target, ZWT_TEST_PFX: '', ZWT_TEST_PFX_PASS_FILE: '' },
        root: app,
        say: (line) => lines.push(line),
      });
      const said = lines.join('\n');
      expect(code, said).toBe(1);
      expect(said).toContain('The server stopped: the time ran out.');
      expect(said).toContain('Not a clean pass (exit status 1): the time ran out; no report arrived.');
      expect(said).toContain('  VM: sent nothing');
      expect(existsSync(join(work, 'publish-timeout'))).toBe(false);
    }, 60_000);

    it('stops, saying so, when the report arrived and the VM never says it has finished, exiting 1 and not waiting for the end of the time', async () => {
      const result = await realRun([], { final: false, report: sampleWackReport() });
      expect(result.code, result.said).toBe(1);
      expect(result.said).toContain('Windows App Certification Kit: overall result PASS');
      expect(result.said).toContain('The VM did not say it had finished within 0.004 minutes of the last news from it. Stopping here.');
      expect(result.said).toContain('the VM never said it had finished (its certificate and package clean-up are not confirmed: look at the VM)');
      expect(result.said).toContain('The server stopped: the VM finished.');
    }, 120_000);

    it('tells the VM that the Mac could not make the packages (here the release exe is missing), the VM stops, and the run exits 1 with the reason', async () => {
      const empty = join(work, 'target-without-the-exe');
      mkdirSync(empty, { recursive: true });
      const result = await realRun([], {}, { target: empty });
      expect(result.code, result.said).toBe(1);
      expect(result.said).toContain('The Mac could not finish its part: package-msix.mjs --identity both failed');
      expect(result.said).toContain('Not found: ');
      expect(result.said).toContain('  VM FAIL [waiting for the Mac] the Mac could not get the packages ready: package-msix.mjs --identity both failed');
      expect(result.said).toContain('the Mac stopped: package-msix.mjs --identity both failed');
      expect(existsSync(result.publish)).toBe(false);
      expect(existsSync(join(result.folder, 'zWorkTracker-store-wack.cer'))).toBe(false);
    }, 120_000);
  });
});
