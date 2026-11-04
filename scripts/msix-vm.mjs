#!/usr/bin/env node
// `pnpm msix:vm`: the whole Windows side of the Store package job, from this Mac, with the Windows VM (UTM). One command here and one line typed
// in an Administrator PowerShell in the VM do all of it:
//   1. The resources.pri of both packages are made in the VM with makepri, sent back, checked and saved in packaging/msix, exactly as
//      `pnpm msix:pri` does it (make-pri.mjs: this script uses its server, its folders, its checks and the first part of its PowerShell).
//   2. Both packages are packed again with those indexes (package-msix.mjs --identity both, the release exe that is there is not rebuilt), and
//      gated: the 60 images and resources.pri at the root, the identities, the version, x64, the package family names. If they pass they are
//      published in ~/msix-build, the PRI-less copies of the same names there renamed first, never deleted.
//   3. A copy of the Store package is signed for the Windows App Certification Kit (WACK) alone, with a certificate made for this run: RSA 3072,
//      its subject exactly the Store publisher, valid 7 days, for code signing only. Its private key lives in a temporary folder and is deleted as
//      soon as the package is signed. The Store package that is published stays unsigned and untouched: it is what is uploaded.
//   4. With ZWT_TEST_PFX and ZWT_TEST_PFX_PASS_FILE set, a copy of the test package is signed with the owner's own test key.
//   5. The VM fetches the signed copy and its public certificate from this Mac, trusts the certificate (LocalMachine\TrustedPeople), runs
//      `appcert.exe test` on the package, sends the XML report back, and takes the certificate and the package WACK installed away again. This
//      script reads the report, prints each test, and saves it. If a signed test package was made the VM installs and starts it as well.
// The script for the VM is built in make-pri.mjs and here, and served at the same fixed path as `pnpm msix:pri`'s, so the one line typed never
// changes. --dry-run does the Mac side for real (packages, certificate, signing, server) with no VM, made-up indexes and a sample report.
import { spawn, spawnSync } from 'node:child_process';
import { X509Certificate, createHash } from 'node:crypto';
import { appendFileSync, chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';

import {
  DEFAULT_HOST,
  DEFAULT_PORT,
  Failure,
  PACKAGE_ID,
  SCRIPT_PATH,
  STATUS_PATH,
  UPLOAD_PATHS,
  VM_DIRECTORY,
  VM_SECTIONS,
  buildRoutes,
  checkCanListen,
  ensureMakepri,
  exchange,
  fillScript,
  indexProblem,
  installIndexes,
  jsonRoute,
  oneLine,
  parseOptions as parseSharedOptions,
  peMachine,
  plain,
  priStatus,
  progressPrinter,
  readFolders,
  sampleIndex,
  scriptFills,
  scriptRoute,
  stageFolders,
  startServer,
  unplatedNames,
  vmLine,
} from './make-pri.mjs';
import { PACKAGES, RESOURCE_INDEX, assetImages, identityOf, lackingAssets, msixFileName, msixVersion, packageFamilyName } from './msix-manifest.mjs';
import { SIPS, cargoTargetRoot, readAppConf } from './msix-stage.mjs';

export { Failure };

/** The most the whole job may take, in minutes: the VM installs a piece of the Windows SDK and runs the certification kit, which takes a while. */
export const DEFAULT_TIMEOUT_MINUTES = 60;
/** Where the VM sends the XML report of the certification kit, and the largest it may be. */
export const REPORT_PATH = '/wack-report.xml';
export const REPORT_LIMIT = 5 * 1024 * 1024;
/** Where the VM tells the Mac what it is doing and, if it stops, why; the largest one may be. A PUT here replaces the one before. */
export const VM_STATUS_PATH = '/vm-status.json';
export const VM_STATUS_LIMIT = 64 * 1024;
/** The only four names the server takes a PUT for: the two indexes, the report and the status of the VM. */
export const VM_UPLOAD_PATHS = Object.freeze({ ...UPLOAD_PATHS, report: REPORT_PATH, status: VM_STATUS_PATH });
/** The folder the server serves the WACK copy, its certificate and the signed test package from. */
export const SERVED_DIRECTORY = '/wack';
/**
 * Microsoft's own link to the installer of the current Windows SDK: Windows SDK for Windows 11 (10.0.28000.2957), September 2026, "Installer" in
 * the table "Windows 11 - 28000 versions" of https://learn.microsoft.com/windows/apps/windows-sdk/downloads (read 2026-11-03). The link answers 302 to
 * https://download.microsoft.com/download/e6cfffdc-0d3e-4c6c-96d7-d491da459a07/KIT_BUNDLE_WINDOWSSDK_MEDIACREATION/winsdksetup.exe, 1,450,344 bytes.
 * The VM checks the Authenticode signature of what it downloads (Valid, signed by Microsoft Corporation) before it runs it.
 */
export const SDK_INSTALLER_URL = 'https://go.microsoft.com/fwlink/?linkid=2382519';
/**
 * The feature of the SDK installer that holds the Windows App Certification Kit. It is `OptionId.WindowsSoftwareLogoToolkit`, and not a name with
 * AppCertificationKit in it, which no source knows: the signed installer's own UserExperienceManifest.xml names "OptionId.WindowsSoftwareLogoToolkit:
 * Windows App Certification Kit", with Application Verifier (OptionId.AvrfExternal) as its dependency (github.com/krebs3r/hourstone-companion,
 * docs/WACK-PREPARATION.md, 2026-09-18), and a Windows 11 PC got appcert.exe 10.0.28000.2957 from it (github.com/GodRayine/SunShift, store/wack-2026-10-07.md).
 */
export const SDK_FEATURE = 'OptionId.WindowsSoftwareLogoToolkit';
/** The package family names the gate holds the packages to, worked out by hand from the identities, so that a fault in the code that derives them is caught. */
export const EXPECTED_FAMILY = Object.freeze({ store: 'PedroMiguelRodriguesJorge.zWorkTracker_54k2cbaqgvhqp', test: 'rustcircle.zWorkTracker.Test_ym7m1j5c19s9r' });
/** The certificate that signs the WACK copy: 3072-bit RSA, 7 days, started an hour before it was made so that a VM clock that is a little slow does not find it "not yet valid". */
export const KEY_BITS = 3072;
export const WACK_VALID_DAYS = 7;
export const WACK_SKEW_MINUTES = 60;
/** How long the script on the VM waits for the Mac, for the SDK installer, and for appcert.exe, in minutes. */
export const VM_POLL_MINUTES = 30;
export const VM_SDK_MINUTES = 25;
export const VM_WACK_MINUTES = 45;
/** After the report, how long the Mac waits for the VM to say it is finished (clean-up included): longer if it has a test package to install. */
export const LINGER_MINUTES = Object.freeze({ afterReport: 3, afterReportWithTestPackage: 15, afterFailure: 2 });

const UNZIP = '/usr/bin/unzip';
const KINDS = Object.freeze(Object.keys(PACKAGES));
const sha256Of = (bytes) => createHash('sha256').update(bytes).digest('hex');
const sha256File = (file) => sha256Of(readFileSync(file));

// ---------------------------------------------------------------------------------------------------------------------------------------
// The command line

const OPTIONS_HELP = [
  ['--dry-run', 'Do the Mac side for real with no VM: stage the folders, rebuild both packages with made-up indexes into a temporary folder (never ~/msix-build), make the certificate and sign and verify the WACK copy there, serve on 127.0.0.1 on any free port and ask the server what the VM would, parse a sample report, delete what it made, and check that no key is left.'],
  ['--host <address>', `The address to serve on, an IPv4 address of this Mac (default ${DEFAULT_HOST}). Not 0.0.0.0.`],
  ['--port <number>', `The port to serve on (default ${DEFAULT_PORT}). The line to type in the VM names it.`],
  ['--timeout <minutes>', `The most the whole job may take (default ${DEFAULT_TIMEOUT_MINUTES}).`],
  ['--out-dir <folder>', 'Where the folder of this run is made, named for the time (YYYYMMDD-HHMM): the WACK copy, its certificate, the report and its summary (default .stack/out/msix-vm).'],
  ['--pri-dir <folder>', "Where the folders for the VM are put (default: msix-pri in Cargo's target folder, as pnpm msix:pri puts them)."],
  ['--publish-dir <folder>', 'Where the two rebuilt packages are published (default ~/msix-build). A package of the same name that is there is renamed first, never deleted.'],
  ['--tools-dir <folder>', 'Where makepri is kept, one folder per SDK version (default ~/msix-build/tools/sdk-buildtools).'],
  ['--sdk-version <version>', `Use this version of ${PACKAGE_ID} (such as 10.0.28000.2957) instead of the latest stable one.`],
  ['--dotnet <path>', 'The dotnet that verifies the makepri package (default: ZWT_DOTNET, then dotnet on the PATH).'],
  ['-h, --help', 'Show this text.'],
];

/** The text of --help: what the command does, each option, the variables it reads and the exit codes. */
export function helpText() {
  const width = Math.max(...OPTIONS_HELP.map(([flag]) => flag.length));
  return [
    'Usage: pnpm msix:vm [options]     (node scripts/msix-vm.mjs [options])',
    '',
    'Does the whole Windows side of the Store package job with the Windows VM: makes both resources.pri with makepri and saves them, packs both',
    'packages again with them and publishes them, signs a copy of the Store package for the Windows App Certification Kit alone, has the VM run the',
    'kit on it, and brings the report back, parsed. It prints one line to type in an Administrator PowerShell in the VM, and nothing else is typed.',
    '',
    'Options:',
    ...OPTIONS_HELP.map(([flag, text]) => `  ${flag.padEnd(width)}  ${text}`),
    '',
    'Variables (all optional):',
    '  ZWT_TEST_PFX, ZWT_TEST_PFX_PASS_FILE   both set: a copy of the test package is signed with that key (the password is read from the file, never shown),',
    '                                         and the VM installs and starts it. One alone is not enough, and nothing is signed.',
    '  ZWT_OPENSSL, ZWT_OSSLSIGNCODE, ZWT_MAKEMSIX   the tools, if they are not where they are looked for.',
    '',
    'Exit status: 0 when the report arrived, passed, and the VM finished; 2 when the report arrived and its overall result is not PASS; 1 for anything else.',
  ].join('\n');
}

/** The command line: make-pri.mjs's, with 60 minutes to wait and the folders for the published packages and for the VM's files. */
export function parseOptions(argv) {
  return parseSharedOptions(argv, { timeoutMinutes: DEFAULT_TIMEOUT_MINUTES, paths: { '--publish-dir': 'publishDir', '--pri-dir': 'priDir' } });
}

// ---------------------------------------------------------------------------------------------------------------------------------------
// The tools: openssl and osslsigncode

/**
 * Runs a tool and collects what it printed. Its standard input is nothing at all (/dev/null): osslsigncode 2.14 with OpenSSL 4 asks the console for the
 * password of a .pfx when its input is a pipe, and fails with "unknown ttyget errno" without ever looking at the file named by -readpass; with no input it reads the file.
 */
function runTool(path, args, options = {}) {
  const run = spawnSync(path, args, { encoding: 'utf8', timeout: 120_000, maxBuffer: 1 << 26, stdio: ['ignore', 'pipe', 'pipe'], ...options });
  return { status: run.status, output: `${run.stdout ?? ''}${run.stderr ?? ''}`, error: run.error };
}

/** The last lines of what a tool said, for a message. */
function tail(text, lines = 12) {
  return text.trim().split('\n').slice(-lines).join('\n');
}

/**
 * The openssl that makes the certificate: one of OpenSSL 3.4 or newer, which can be told when a certificate starts and ends (-not_before, -not_after) and
 * not to encrypt the key (-noenc). The `openssl` macOS ships is LibreSSL and has neither. Looked for at ZWT_OPENSSL, then where Homebrew puts it, then on the PATH.
 */
export function findOpenssl(env = process.env) {
  const candidates = [env.ZWT_OPENSSL, '/opt/homebrew/bin/openssl', '/opt/homebrew/opt/openssl@4/bin/openssl', '/opt/homebrew/opt/openssl/bin/openssl', '/usr/local/opt/openssl/bin/openssl', 'openssl'].filter(Boolean);
  const problems = [];
  for (const candidate of candidates) {
    const version = runTool(candidate, ['version']);
    if (version.error || version.status !== 0) {
      problems.push(`${candidate}: cannot be run`);
      continue;
    }
    const first = version.output.trim().split('\n')[0] ?? '';
    if (!/^OpenSSL \d/.test(first)) {
      problems.push(`${candidate}: ${first}, which is not OpenSSL`);
      continue;
    }
    const help = runTool(candidate, ['req', '-help']).output;
    if (!help.includes('-not_before') || !help.includes('-noenc')) {
      problems.push(`${candidate}: ${first}, which has no -not_before and -noenc on req`);
      continue;
    }
    return { path: candidate, version: first };
  }
  throw new Failure(`No OpenSSL that can make the certificate was found (${problems.join('; ')}). Install one with brew install openssl, or name it with ZWT_OPENSSL.`);
}

/** The osslsigncode that signs the packages: a 2.x that says it signs APPX files (MSIX packages). Looked for at ZWT_OSSLSIGNCODE, then in Homebrew's places, then on the PATH. */
export function findOsslsigncode(env = process.env) {
  const candidates = [env.ZWT_OSSLSIGNCODE, '/opt/homebrew/bin/osslsigncode', '/usr/local/bin/osslsigncode', 'osslsigncode'].filter(Boolean);
  const problems = [];
  for (const candidate of candidates) {
    const version = runTool(candidate, ['--version']);
    const match = /^osslsigncode (\d+)\.(\d+)/m.exec(version.output);
    if (!match) {
      problems.push(`${candidate}: cannot be run`);
      continue;
    }
    if (Number(match[1]) < 2 || !/\bAPPX\b/.test(runTool(candidate, ['--help']).output)) {
      problems.push(`${candidate}: osslsigncode ${match[1]}.${match[2]} does not say it signs APPX packages`);
      continue;
    }
    return { path: candidate, version: `${match[1]}.${match[2]}` };
  }
  throw new Failure(`No osslsigncode that signs MSIX packages was found (${problems.join('; ')}). Install it with brew install osslsigncode, or name it with ZWT_OSSLSIGNCODE.`);
}

// ---------------------------------------------------------------------------------------------------------------------------------------
// Reading a package

/** The names inside a zip file, as `unzip -Z1` lists them. */
export function packageEntries(file) {
  const run = spawnSync(UNZIP, ['-Z1', file], { encoding: 'utf8', maxBuffer: 1 << 26 });
  if (run.error || run.status !== 0) throw new Failure(`${file} cannot be read as a zip file${run.error ? `: ${run.error.message}` : `:\n${run.stderr}`}`);
  return run.stdout.split('\n').filter(Boolean);
}

/** One file out of a package, as bytes, or null if it has none by that name. */
export function packageEntry(file, entry) {
  const run = spawnSync(UNZIP, ['-p', file, entry], { maxBuffer: 1 << 28 });
  if (run.error) throw new Failure(`Could not run ${UNZIP}: ${run.error.message}`);
  return run.status === 0 && Buffer.isBuffer(run.stdout) ? run.stdout : null;
}

function unescapeXml(text) {
  const characters = { lt: '<', gt: '>', quot: '"', apos: "'", amp: '&' };
  return text.replace(/&(lt|gt|quot|apos|amp);/g, (_, name) => characters[name]);
}

/** The identity read back from the text of an AppxManifest.xml: `{ name, publisher, publisherDisplayName, version, architecture }`, each undefined if the manifest has not got it. */
export function manifestIdentity(manifest) {
  const tag = /<Identity\s[^>]*>/.exec(manifest)?.[0] ?? '';
  const attribute = (name) => {
    const value = new RegExp(`\\s${name}="([^"]*)"`).exec(tag)?.[1];
    return value === undefined ? undefined : unescapeXml(value);
  };
  const shown = /<PublisherDisplayName>([^<]*)</.exec(manifest)?.[1];
  return { name: attribute('Name'), publisher: attribute('Publisher'), publisherDisplayName: shown === undefined ? undefined : unescapeXml(shown), version: attribute('Version'), architecture: attribute('ProcessorArchitecture') };
}

/** The Publisher in the manifest inside a package. */
export function packagePublisher(file) {
  const manifest = packageEntry(file, 'AppxManifest.xml');
  const publisher = manifest === null ? undefined : manifestIdentity(manifest.toString('utf8')).publisher;
  if (!publisher) throw new Failure(`${file} has no AppxManifest.xml with a Publisher.`);
  return publisher;
}

// ---------------------------------------------------------------------------------------------------------------------------------------
// The certificate that signs the WACK copy

const SUBJECT = /^CN=[A-Za-z0-9](?:[A-Za-z0-9 ._-]{0,62}[A-Za-z0-9])?$/;
const CODE_SIGNING = '1.3.6.1.5.5.7.3.3';

/** `YYYYMMDDHHMMSSZ`, in UTC: how openssl is told when a certificate starts and ends. */
export function asn1Time(date) {
  const pad = (number, width = 2) => String(number).padStart(width, '0');
  return `${pad(date.getUTCFullYear(), 4)}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}Z`;
}

/**
 * What the certificate for the WACK copy is: pure, so a test can read it. Its subject is `subject` exactly, a single common name (`CN=` and plain
 * characters only, since it is written into an openssl configuration file), RSA of `keyBits` bits, valid for exactly `days` days from `skewMinutes` before
 * `now`, and good for one thing: its key usage is digitalSignature, its extended key usage codeSigning, and basicConstraints says CA:FALSE, all critical.
 * Returns the values and `config`, the text of the openssl configuration file that makes it.
 */
export function certificateSpec({ subject, now = new Date(), days = WACK_VALID_DAYS, skewMinutes = WACK_SKEW_MINUTES, keyBits = KEY_BITS }) {
  if (typeof subject !== 'string' || !SUBJECT.test(subject)) throw new Error(`The certificate subject must be one common name such as CN=1DEF8D7B-1D68-4604-8047-048DC92CF3A9 (got ${JSON.stringify(subject)}).`);
  if (!Number.isInteger(days) || days < 1 || days > 30) throw new Error(`The certificate must be valid for a whole number of days from 1 to 30 (got ${days}).`);
  if (!Number.isInteger(skewMinutes) || skewMinutes < 0 || skewMinutes > 24 * 60) throw new Error(`The start of the certificate may be put back by 0 to 1440 minutes (got ${skewMinutes}).`);
  if (!Number.isInteger(keyBits) || keyBits < 2048) throw new Error(`The key must have at least 2048 bits (got ${keyBits}).`);
  const start = Math.floor(now.getTime() / 1000) * 1000 - skewMinutes * 60_000;
  const notBefore = new Date(start);
  const notAfter = new Date(start + days * 86_400_000);
  const extensions = Object.freeze({
    basicConstraints: 'critical,CA:FALSE',
    keyUsage: 'critical,digitalSignature',
    extendedKeyUsage: 'critical,codeSigning',
    subjectKeyIdentifier: 'hash',
  });
  const config = [
    '[req]',
    'distinguished_name = dn',
    'prompt = no',
    'x509_extensions = v3_wack',
    '',
    '[dn]',
    `CN = ${subject.slice('CN='.length)}`,
    '',
    '[v3_wack]',
    ...Object.entries(extensions).map(([name, value]) => `${name} = ${value}`),
    '',
  ].join('\n');
  return Object.freeze({ subject, keyBits, days, notBefore, notAfter, extensions, config });
}

/** The arguments of `openssl` that make the self-signed certificate of `spec`, a key with no passphrase, in the files given. */
export function opensslArguments(spec, { configFile, keyFile, certFile }) {
  return ['req', '-x509', '-newkey', `rsa:${spec.keyBits}`, '-noenc', '-keyout', keyFile, '-out', certFile, '-sha256', '-config', configFile, '-extensions', 'v3_wack', '-not_before', asn1Time(spec.notBefore), '-not_after', asn1Time(spec.notAfter)];
}

/**
 * Makes the key and the self-signed certificate of `spec` in `dir`, which must be a folder of this run's own (mode 700), and reads the certificate back
 * to see that it is what was asked for. Every file is mode 600. Returns `{ keyFile, certFile, pem, facts }`, `facts` being what was read back.
 */
export function createWackCertificate({ openssl, dir, spec }) {
  const configFile = join(dir, 'wack.cnf');
  const keyFile = join(dir, 'wack-key.pem');
  const certFile = join(dir, 'wack-cert.pem');
  writeFileSync(configFile, spec.config, { mode: 0o600 });
  const run = runTool(openssl.path, opensslArguments(spec, { configFile, keyFile, certFile }));
  if (run.status !== 0 || !existsSync(keyFile) || !existsSync(certFile)) throw new Failure(`openssl could not make the certificate (exit ${run.status}):\n${tail(run.output)}`);
  for (const file of [configFile, keyFile, certFile]) chmodSync(file, 0o600);
  const pem = readFileSync(certFile, 'utf8');
  const facts = certificateFacts(pem, spec, openssl, certFile);
  return { keyFile, certFile, pem, facts };
}

/** Reads the certificate back and throws if anything in it is not what `spec` says; returns what it holds, for the log. */
export function certificateFacts(pem, spec, openssl, certFile) {
  const x509 = new X509Certificate(pem);
  const wrong = [];
  if (x509.subject !== spec.subject) wrong.push(`its subject is ${JSON.stringify(x509.subject)}, not ${spec.subject}`);
  if (x509.issuer !== spec.subject) wrong.push(`its issuer is ${JSON.stringify(x509.issuer)}: it is not self-signed`);
  if (x509.ca !== false) wrong.push('it is a CA certificate');
  if (JSON.stringify(x509.keyUsage) !== JSON.stringify([CODE_SIGNING])) wrong.push(`its extended key usage is ${JSON.stringify(x509.keyUsage)}, not only code signing (${CODE_SIGNING})`);
  if (x509.validFromDate.getTime() !== spec.notBefore.getTime() || x509.validToDate.getTime() !== spec.notAfter.getTime()) wrong.push(`it is valid ${x509.validFrom} to ${x509.validTo}, not ${spec.notBefore.toISOString()} to ${spec.notAfter.toISOString()}`);
  const bits = x509.publicKey.asymmetricKeyDetails?.modulusLength;
  if (x509.publicKey.asymmetricKeyType !== 'rsa' || bits !== spec.keyBits) wrong.push(`its key is ${x509.publicKey.asymmetricKeyType} ${bits ?? '?'} bits, not RSA ${spec.keyBits}`);
  if (!x509.verify(x509.publicKey)) wrong.push('its signature does not verify with its own key');
  const text = runTool(openssl.path, ['x509', '-in', certFile, '-noout', '-text', '-nameopt', 'RFC2253']).output;
  for (const needle of ['Digital Signature', 'Code Signing', 'CA:FALSE', 'sha256WithRSAEncryption']) if (!text.includes(needle)) wrong.push(`openssl's text of it lacks "${needle}"`);
  if (/Certificate Sign|CRL Sign|Key Encipherment|Server Authentication|Client Authentication|Any Extended Key Usage/.test(text)) wrong.push('it allows more than code signing');
  if (wrong.length > 0) throw new Failure(`The certificate that was made is not what was asked for: ${wrong.join('; ')}.`);
  return {
    subject: x509.subject,
    notBefore: x509.validFromDate.toISOString(),
    notAfter: x509.validToDate.toISOString(),
    thumbprint: x509.fingerprint.replaceAll(':', ''),
    sha256: x509.fingerprint256.replaceAll(':', '').toLowerCase(),
    serial: x509.serialNumber,
    keyBits: bits,
    keyUsage: 'digitalSignature (critical)',
    extendedKeyUsage: 'codeSigning (critical)',
    basicConstraints: 'CA:FALSE (critical)',
    signatureAlgorithm: 'sha256WithRSAEncryption',
  };
}

/** Whether `text`, the output of osslsigncode verify, says the signature was verified: the two lines it prints, and what it returned. */
export function verifiedOk(status, text) {
  return status === 0 && /Signature verification: ok/.test(text) && /Number of verified signatures: 1\b/.test(text);
}

/** The digest algorithm osslsigncode says the signature was made with ("Message digest algorithm: SHA256"), or null. For an MSIX package it is the one of AppxBlockMap.xml. */
export function digestOf(text) {
  return /^\s*Message digest algorithm: (\S+)/m.exec(text)?.[1] ?? null;
}

function signWith(osslsigncode, credentials, { input, output }) {
  // osslsigncode does not sign into a file that is there already (it fails as if the password were wrong).
  rmSync(output, { force: true });
  const run = runTool(osslsigncode.path, ['sign', ...credentials, '-h', 'sha256', '-in', input, '-out', output]);
  if (run.status !== 0 || !/Succeeded/.test(run.output) || !existsSync(output)) {
    rmSync(output, { force: true });
    throw new Failure(`osslsigncode could not sign ${basename(input)} (exit ${run.status}):\n${tail(run.output)}`);
  }
}

function verifyWith(osslsigncode, file, caFile) {
  const run = runTool(osslsigncode.path, ['verify', '-in', file, '-CAfile', caFile]);
  if (!verifiedOk(run.status, run.output)) throw new Failure(`osslsigncode verify did not accept ${basename(file)} (exit ${run.status}):\n${tail(run.output)}`);
  const digest = digestOf(run.output);
  if (digest !== 'SHA256') throw new Failure(`${basename(file)} is signed with the digest ${digest ?? '(not named)'}, and it must be SHA256.`);
  return 'Signature verification: ok; Number of verified signatures: 1; Message digest algorithm: SHA256';
}

/** What a signed copy must still have in common with the package it was made from: every file it had, the manifest and the block map byte for byte, and one more entry, the signature. */
function checkSameContents(unsigned, signed) {
  const before = packageEntries(unsigned);
  const after = packageEntries(signed);
  const added = after.filter((entry) => !before.includes(entry));
  const lost = before.filter((entry) => !after.includes(entry));
  if (lost.length > 0 || added.length !== 1 || added[0] !== 'AppxSignature.p7x') {
    throw new Failure(`The signed copy is not the package plus its signature: it lost ${JSON.stringify(lost)} and gained ${JSON.stringify(added)}.`);
  }
  for (const entry of ['AppxManifest.xml', 'AppxBlockMap.xml', ...before.filter((one) => one === RESOURCE_INDEX || one.endsWith('.exe'))]) {
    const one = packageEntry(unsigned, entry);
    const other = packageEntry(signed, entry);
    if (one === null || other === null || !one.equals(other)) throw new Failure(`${entry} is not the same in the signed copy and in the package.`);
  }
  return `${before.length} files, plus AppxSignature.p7x`;
}

/** The temporary folders that hold a key, so that an exit of the process in the middle of signing still takes them away. */
const keyFolders = new Set();
process.on('exit', () => {
  for (const dir of keyFolders) rmSync(dir, { recursive: true, force: true });
});

/**
 * Signs a COPY of `storePackage` for the Windows App Certification Kit alone, and leaves the package itself untouched (its SHA-256 is read before and
 * after, and must be the same). The certificate is made for this run in a folder under the system's temporary folder that only this user can read; the
 * signature is checked with osslsigncode verify against that certificate; and the key is deleted, with the folder, in a `finally` the moment signing is
 * over, whatever happened. The certificate's subject is the Publisher of the package's own manifest, and nothing is signed if that is not a plain common name.
 * Writes into `outDir` the signed copy (`<name>-wack.msix`) and the public certificate (DER, `zWorkTracker-store-wack.cer`). Returns what was done.
 */
export function signWackCopy({ storePackage, outDir, now = new Date(), env = process.env, say = () => {}, tools = null }) {
  const openssl = tools?.openssl ?? findOpenssl(env);
  const osslsigncode = tools?.osslsigncode ?? findOsslsigncode(env);
  const publisher = packagePublisher(storePackage);
  const spec = certificateSpec({ subject: publisher, now });
  const hashBefore = sha256File(storePackage);
  const signedFile = join(outDir, basename(storePackage).replace(/\.msix$/, '-wack.msix'));
  const certificateFile = join(outDir, 'zWorkTracker-store-wack.cer');
  mkdirSync(outDir, { recursive: true });
  const keyDir = mkdtempSync(join(tmpdir(), 'zwt-wack-'));
  keyFolders.add(keyDir);
  let keyFile = null;
  let facts;
  let verified;
  let contents;
  try {
    chmodSync(keyDir, 0o700);
    const made = createWackCertificate({ openssl, dir: keyDir, spec });
    keyFile = made.keyFile;
    facts = made.facts;
    say(`Certificate for the WACK copy (made for this run, with ${openssl.version}): ${facts.subject}, RSA ${facts.keyBits}, ${facts.signatureAlgorithm}, valid ${facts.notBefore} to ${facts.notAfter}`);
    say(`  key usage ${facts.keyUsage}, extended key usage ${facts.extendedKeyUsage}, ${facts.basicConstraints}; thumbprint ${facts.thumbprint}`);
    signWith(osslsigncode, ['-certs', made.certFile, '-key', made.keyFile], { input: storePackage, output: signedFile });
    verified = verifyWith(osslsigncode, signedFile, made.certFile);
    contents = checkSameContents(storePackage, signedFile);
    // The public part, as a file Windows imports (DER, which Import-Certificate reads); the PEM is also what the check above was made against.
    writeFileSync(certificateFile, new X509Certificate(made.pem).raw);
  } catch (error) {
    rmSync(signedFile, { force: true });
    rmSync(certificateFile, { force: true });
    throw error;
  } finally {
    // The key first, by itself, and then everything else that was made with it. Nothing of it is written anywhere else, and nothing is printed.
    if (keyFile !== null) rmSync(keyFile, { force: true });
    rmSync(keyDir, { recursive: true, force: true });
    keyFolders.delete(keyDir);
  }
  const keyRemoved = !existsSync(keyDir);
  if (!keyRemoved) throw new Failure(`The folder ${keyDir}, which held the private key, could not be removed. Remove it by hand.`);
  const hashAfter = sha256File(storePackage);
  if (hashAfter !== hashBefore) throw new Failure(`The Store package changed while its copy was signed: SHA-256 ${hashBefore} became ${hashAfter}.`);
  say(`osslsigncode ${osslsigncode.version} verify (against that certificate): ${verified}`);
  say(`  ${contents}; the signed copy is the package and its signature, nothing else`);
  say(`The private key was deleted with its folder, ${keyDir} (gone: ${keyRemoved}).`);
  return {
    signedFile,
    certificateFile,
    certificate: { ...facts, derSha256: sha256File(certificateFile), derBytes: statSync(certificateFile).size },
    signedSha256: sha256File(signedFile),
    signedBytes: statSync(signedFile).size,
    unsignedSha256: { before: hashBefore, after: hashAfter },
    verified,
    keyDir,
    keyRemoved,
    tools: { openssl: openssl.version, osslsigncode: osslsigncode.version },
  };
}

/**
 * Signs a COPY of the test package with the owner's own test key, only if both ZWT_TEST_PFX (the .pfx) and ZWT_TEST_PFX_PASS_FILE (a file holding its
 * password) are set. The password is never read here: osslsigncode and openssl are given the path of the file. The public certificate is read out of the
 * .pfx to check that its subject is the test package's publisher (osslsigncode signs a package for any publisher, and Windows then refuses to install it) and
 * to verify the result. Returns `{ skipped }` with the reason when nothing was signed, or what was done.
 */
export function signTestCopy({ testPackage, outDir, env = process.env, say = () => {}, tools = null }) {
  const pfx = (env.ZWT_TEST_PFX ?? '').trim();
  const passFile = (env.ZWT_TEST_PFX_PASS_FILE ?? '').trim();
  if (pfx === '' && passFile === '') return { skipped: 'ZWT_TEST_PFX and ZWT_TEST_PFX_PASS_FILE are not set' };
  if (pfx === '' || passFile === '') return { skipped: `only ${pfx === '' ? 'ZWT_TEST_PFX_PASS_FILE' : 'ZWT_TEST_PFX'} is set, and both are needed` };
  for (const [what, file] of [['ZWT_TEST_PFX', pfx], ['ZWT_TEST_PFX_PASS_FILE', passFile]]) {
    if (!existsSync(file) || !statSync(file).isFile()) return { skipped: `${what} names ${file}, which is not a file` };
  }
  const openssl = tools?.openssl ?? findOpenssl(env);
  const osslsigncode = tools?.osslsigncode ?? findOsslsigncode(env);
  const publisher = packagePublisher(testPackage);
  const signedFile = join(outDir, basename(testPackage).replace(/-unsigned\.msix$/, '-signed.msix'));
  if (signedFile === testPackage) throw new Failure(`The test package ${testPackage} is not named ...-unsigned.msix, so the name of its signed copy cannot be made.`);
  const dir = mkdtempSync(join(tmpdir(), 'zwt-test-sign-'));
  keyFolders.add(dir);
  try {
    chmodSync(dir, 0o700);
    const certFile = join(dir, 'signer.pem');
    // `-passin file:` reads the first line of the file; the password is not in the arguments, and openssl does not print it.
    let read = runTool(openssl.path, ['pkcs12', '-in', pfx, '-nokeys', '-clcerts', '-passin', `file:${passFile}`, '-out', certFile]);
    if (read.status !== 0) read = runTool(openssl.path, ['pkcs12', '-legacy', '-in', pfx, '-nokeys', '-clcerts', '-passin', `file:${passFile}`, '-out', certFile]);
    if (read.status !== 0 || !existsSync(certFile)) return { skipped: `openssl could not open ${pfx} with the password in ${passFile}: ${oneLine(tail(read.output, 3))}` };
    const x509 = new X509Certificate(readFileSync(certFile, 'utf8'));
    if (x509.subject !== publisher) return { skipped: `the certificate in ${pfx} has the subject ${JSON.stringify(x509.subject)}, and the test package's Publisher is ${JSON.stringify(publisher)}: Windows would not install it` };
    signWith(osslsigncode, ['-pkcs12', pfx, '-readpass', passFile], { input: testPackage, output: signedFile });
    const verified = verifyWith(osslsigncode, signedFile, certFile);
    const contents = checkSameContents(testPackage, signedFile);
    const thumbprint = x509.fingerprint.replaceAll(':', '');
    say(`Test package signed with the key in ${pfx} (password read from ${passFile}): ${x509.subject}, thumbprint ${thumbprint}, valid ${x509.validFromDate.toISOString()} to ${x509.validToDate.toISOString()}`);
    say(`  osslsigncode verify: ${verified}; ${contents}`);
    return { signedFile, signedSha256: sha256File(signedFile), signedBytes: statSync(signedFile).size, signerThumbprint: thumbprint, signerSubject: x509.subject, notAfter: x509.validToDate.toISOString(), verified };
  } finally {
    rmSync(dir, { recursive: true, force: true });
    keyFolders.delete(dir);
  }
}

/** Looks through a folder, all the way down, for anything that could be key material: a PEM private key in any file, or a file named like a key or a .pfx. Returns the paths. */
export function keyMaterialIn(dir) {
  const found = [];
  const walk = (folder) => {
    for (const entry of readdirSync(folder, { withFileTypes: true })) {
      const path = join(folder, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (/\.(pfx|p12|key|jks)$|key\.pem$|\.pass$|password/i.test(entry.name) || (statSync(path).size < 1 << 22 && /-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(readFileSync(path, 'latin1')))) found.push(path);
    }
  };
  walk(dir);
  return found;
}

// ---------------------------------------------------------------------------------------------------------------------------------------
// The report of the Windows App Certification Kit
//
// What appcert.exe writes with `-reportoutputpath` is XML, read off a real report (a public gist of the Servo project's: gist.github.com/
// jdm/97674e9c83de6c8f1617a519996a379d, made on Windows 10 1909 in 2020 for a UWP package, 29 tests, read 2026-11-03), off ChristopheLav/wack-certification's
// Analyze-Results.ps1 and the XSL at gist.github.com/milgner/5015106, which read the same elements, and off GodRayine/SunShift's store/wack-2026-10-07.md,
// which ran the kit 10.0.28000.2957 on Windows 11 on an MSIX package:
//   <REPORT OVERALL_RESULT="PASS|FAIL" VERSION TOOLSET_ARCHITECTURE APP_TYPE APP_NAME APP_VERSION OS OSVERSION PARTIAL_RUN VALIDATION_TYPE ReportGenerationTime ...>
//     <REQUIREMENTS>
//       <REQUIREMENT NUMBER TITLE RATIONALE>
//         <TEST INDEX NAME DESCRIPTION EXECUTIONTIME OPTIONAL="TRUE|FALSE">
//           <MESSAGES><MESSAGE TEXT="..."/> ...</MESSAGES>
//           <RESULT><![CDATA[PASS]]></RESULT>        (PASS or FAIL in every report seen)
//         </TEST>
//     </REQUIREMENTS>
//     <APPLICATIONS>, <DEPENDENCY_INFORMATION>: what the kit saw of the package, thousands of elements; not read.
// A test that is OPTIONAL and fails does not change the overall result: Microsoft calls the optional tests of a Desktop Bridge package "informational only"
// (learn.microsoft.com/windows/uwp/debug-test-perf/windows-desktop-bridge-app-tests), and SunShift's report has OVERALL_RESULT=PASS with one optional test FAIL.
// Such a result is shown here as WARN, as the kit's own page shows it. A RESULT of WARN or WARNING is taken as a warning too (no report seen has one, but the
// kit's report page is said to show warnings). Anything else is UNKNOWN, and is shown, never counted as a pass.

const XML_ENTITIES = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };

function decodeEntities(text) {
  if (!text.includes('&')) return text;
  return text.replace(/&(?:#(\d{1,7})|#x([0-9A-Fa-f]{1,6})|(lt|gt|amp|quot|apos));/g, (whole, decimal, hex, named) => {
    if (named) return XML_ENTITIES[named];
    const code = decimal !== undefined ? Number(decimal) : Number.parseInt(hex, 16);
    return code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff) ? String.fromCodePoint(code) : whole;
  });
}

/** The index of the `>` that ends the tag that starts at `from`, not counting one inside a quoted attribute value. -1 if there is none. */
function endOfTag(text, from) {
  let quote = '';
  for (let at = from; at < text.length; at++) {
    const char = text[at];
    if (quote !== '') {
      if (char === quote) quote = '';
    } else if (char === '"' || char === "'") {
      quote = char;
    } else if (char === '>') {
      return at;
    }
  }
  return -1;
}

/**
 * A small XML reader for what the kit writes: elements, attributes, text, CDATA, comments and the XML declaration. It builds `{ name, attrs, children, text }`
 * for the root. A DOCTYPE or any other declaration is refused (an entity defined there could swell the text), and so are a name that is not closed as it was opened,
 * text outside the root, more than `maxNodes` elements and nesting deeper than `maxDepth`. Entities are the five of XML and numbers.
 */
export function parseXml(text, { maxNodes = 400_000, maxDepth = 64 } = {}) {
  const stack = [];
  let root = null;
  let nodes = 0;
  let at = 0;
  const fail = (message) => {
    throw new Failure(`The XML cannot be read: ${message} (at character ${at}).`);
  };
  while (at < text.length) {
    const open = text.indexOf('<', at);
    const between = text.slice(at, open < 0 ? text.length : open);
    if (between !== '') {
      if (stack.length > 0) stack[stack.length - 1].text += decodeEntities(between);
      else if (between.trim() !== '' && between !== '\ufeff') fail('there is text outside the root element');
    }
    if (open < 0) break;
    at = open;
    if (text.startsWith('<!--', open)) {
      const close = text.indexOf('-->', open + 4);
      if (close < 0) fail('a comment is not closed');
      at = close + 3;
    } else if (text.startsWith('<![CDATA[', open)) {
      const close = text.indexOf(']]>', open + 9);
      if (close < 0) fail('a CDATA section is not closed');
      if (stack.length === 0) fail('a CDATA section is outside the root element');
      stack[stack.length - 1].text += text.slice(open + 9, close);
      at = close + 3;
    } else if (text.startsWith('<?', open)) {
      const close = text.indexOf('?>', open + 2);
      if (close < 0) fail('a processing instruction is not closed');
      at = close + 2;
    } else if (text.startsWith('<!', open)) {
      fail('a DOCTYPE or another declaration is not accepted');
    } else {
      const close = endOfTag(text, open + 1);
      if (close < 0) fail('a tag is not closed');
      const inside = text.slice(open + 1, close);
      if (inside.startsWith('/')) {
        const element = stack.pop();
        if (element === undefined || element.name !== inside.slice(1).trim()) fail(`</${inside.slice(1).trim()}> closes ${element ? `<${element.name}>` : 'nothing'}`);
      } else {
        const selfClosing = inside.endsWith('/');
        const body = selfClosing ? inside.slice(0, -1) : inside;
        const name = /^[A-Za-z_:][\w:.-]*/.exec(body)?.[0];
        if (name === undefined) fail('a tag has no name');
        const attrs = {};
        let rest = body.slice(name.length);
        const attribute = /^\s+([A-Za-z_:][\w:.-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/;
        for (let match = attribute.exec(rest); match; match = attribute.exec(rest)) {
          attrs[match[1]] = decodeEntities(match[2] ?? match[3] ?? '');
          rest = rest.slice(match[0].length);
        }
        if (rest.trim() !== '') fail(`<${name}> has something that is not an attribute: ${JSON.stringify(rest.trim().slice(0, 40))}`);
        const element = { name, attrs, children: [], text: '' };
        if (++nodes > maxNodes) fail(`there are more than ${maxNodes} elements`);
        if (stack.length > 0) stack[stack.length - 1].children.push(element);
        else if (root === null) root = element;
        else fail('there is a second root element');
        if (!selfClosing) {
          if (stack.length >= maxDepth) fail(`the elements are nested deeper than ${maxDepth}`);
          stack.push(element);
        }
      }
      at = close + 1;
    }
  }
  if (stack.length > 0) fail(`<${stack[stack.length - 1].name}> is not closed`);
  if (root === null) fail('there is no element');
  return root;
}

/** The text of an XML file given as bytes: UTF-16 (with its byte order mark) as the kit may write it, or UTF-8 with or without one. */
export function decodeXmlBytes(bytes) {
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) return bytes.toString('utf16le', 2);
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) return Buffer.from(bytes.subarray(2)).swap16().toString('utf16le');
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return bytes.toString('utf8', 3);
  return bytes.toString('utf8');
}

/** The value of the attribute `name` of an element, whatever the case of its name, or undefined. */
function attributeOf(element, name) {
  const wanted = name.toLowerCase();
  for (const [key, value] of Object.entries(element.attrs)) if (key.toLowerCase() === wanted) return value;
  return undefined;
}

function descendants(element, name) {
  const found = [];
  for (const child of element.children) {
    if (child.name === name) found.push(child);
    found.push(...descendants(child, name));
  }
  return found;
}

/** What the kit made of one test: PASS, FAIL (a required test), WARN (an optional test that failed, or a result of WARN) or UNKNOWN (anything else). */
export function testOutcome(result, optional) {
  const word = String(result).trim().toUpperCase();
  if (word === 'PASS') return 'PASS';
  if (word === 'FAIL') return optional ? 'WARN' : 'FAIL';
  if (word === 'WARN' || word === 'WARNING') return 'WARN';
  return 'UNKNOWN';
}

/**
 * Reads a report of the Windows App Certification Kit, as bytes or text. Returns `{ attributes, overall, requirements, tests, counts, problems }`:
 * the attributes of REPORT, its OVERALL_RESULT (upper case, or null), each requirement with its tests (`{ index, name, description, optional, rawResult,
 * outcome, executionTime, messages }`), the count of each outcome, and `problems`, what does not add up (an overall result that says PASS with a test that
 * failed, or FAIL with none). Throws a Failure for a file that is not a report.
 */
export function parseWackReport(input) {
  const root = parseXml(typeof input === 'string' ? input : decodeXmlBytes(input));
  if (root.name !== 'REPORT') throw new Failure(`The file is not a report of the Windows App Certification Kit: its first element is <${root.name}> and not <REPORT>.`);
  const requirements = descendants(root, 'REQUIREMENTS').flatMap((one) => descendants(one, 'REQUIREMENT'));
  const reports = requirements.map((requirement) => ({
    number: attributeOf(requirement, 'NUMBER') ?? '',
    title: attributeOf(requirement, 'TITLE') ?? '',
    tests: descendants(requirement, 'TEST').map((test) => {
      const optional = (attributeOf(test, 'OPTIONAL') ?? '').trim().toUpperCase() === 'TRUE';
      const rawResult = (test.children.find((child) => child.name === 'RESULT')?.text ?? '').trim();
      return {
        index: attributeOf(test, 'INDEX') ?? '',
        name: attributeOf(test, 'NAME') ?? '',
        description: attributeOf(test, 'DESCRIPTION') ?? '',
        executionTime: attributeOf(test, 'EXECUTIONTIME') ?? '',
        optional,
        rawResult,
        outcome: testOutcome(rawResult, optional),
        messages: descendants(test, 'MESSAGE').map((message) => attributeOf(message, 'TEXT') ?? message.text.trim()),
      };
    }),
  }));
  const tests = reports.flatMap((requirement) => requirement.tests);
  const counts = { PASS: 0, FAIL: 0, WARN: 0, UNKNOWN: 0 };
  for (const test of tests) counts[test.outcome]++;
  const overallText = (attributeOf(root, 'OVERALL_RESULT') ?? '').trim().toUpperCase();
  const overall = overallText === '' ? null : overallText;
  const problems = [];
  if (tests.length === 0) problems.push('the report holds no test');
  if (overall === null) problems.push('the report states no overall result');
  if (overall === 'PASS' && counts.FAIL > 0) problems.push(`the overall result is PASS but ${counts.FAIL} required test(s) failed`);
  if (overall !== null && overall !== 'PASS' && counts.FAIL === 0) problems.push(`the overall result is ${overall} but no required test failed: look at the report itself`);
  if (counts.UNKNOWN > 0) problems.push(`${counts.UNKNOWN} test(s) have a result that is neither PASS, FAIL nor WARN`);
  const partial = (attributeOf(root, 'PARTIAL_RUN') ?? '').trim().toUpperCase() === 'TRUE';
  if (partial) problems.push('PARTIAL_RUN is TRUE: not every test was run');
  // The kit runs the tests that need the app installed only if it can install the package; otherwise (an unsigned package, say) it runs the tests on the
  // files only, and says so in an attribute (GodRayine/SunShift's report has FileOnlyTests=True with PARTIAL_RUN=FALSE).
  const fileOnly = [root, ...root.children].flatMap((element) => Object.entries(element.attrs).filter(([name, value]) => /file.?only/i.test(name) && value.trim().toUpperCase() === 'TRUE'))[0];
  if (fileOnly) problems.push(`${fileOnly[0]} is TRUE: the kit ran the tests on the files only, as it does when it cannot install the package, so the tests that start the app did not run`);
  return { attributes: { ...root.attrs }, overall, requirements: reports, tests, counts, problems, partial };
}

/** Whether a parsed report is a pass the exit status may call one: the overall result is PASS, no required test failed, nothing is not understood, and every test was run. */
export function reportPasses(report) {
  return report.overall === 'PASS' && report.counts.FAIL === 0 && report.counts.UNKNOWN === 0 && !report.partial;
}

/** The lines that show a parsed report: the overall result and what the kit and the PC were, then every test with its result, and the messages of each that did not pass. */
export function formatWackReport(report, { maxMessages = 8, maxLength = 300 } = {}) {
  const attr = (name) => attributeOf({ attrs: report.attributes }, name);
  const lines = [];
  lines.push(`Windows App Certification Kit: overall result ${report.overall ?? '(not in the report)'}`);
  const kit = [attr('VERSION') && `kit ${attr('VERSION')}`, attr('TOOLSET_ARCHITECTURE'), attr('OS') && `${attr('OS')}${attr('OSVERSION') ? ` ${attr('OSVERSION')}` : ''}`].filter(Boolean).join(', ');
  const app = [attr('APP_NAME'), attr('APP_VERSION'), attr('APP_TYPE') && `type ${attr('APP_TYPE')}`, attr('VALIDATION_TYPE') && `validation ${attr('VALIDATION_TYPE')}`].filter(Boolean).join(' ');
  if (kit) lines.push(`  ${oneLine(kit, 200)}`);
  if (app) lines.push(`  ${oneLine(app, 200)}`);
  const modes = Object.entries(report.attributes).filter(([name]) => /^(?:PARTIAL_RUN|.*FILE.?ONLY.*)$/i.test(name));
  if (modes.length > 0) lines.push(`  ${modes.map(([name, value]) => `${name}=${oneLine(value, 40)}`).join(', ')}`);
  const { PASS, FAIL, WARN, UNKNOWN } = report.counts;
  lines.push(`  ${report.tests.length} tests: ${PASS} PASS, ${FAIL} FAIL, ${WARN} WARN (an optional test that failed, which the overall result does not count), ${UNKNOWN} not understood`);
  for (const requirement of report.requirements) {
    lines.push(`  ${requirement.number ? `[${requirement.number}] ` : ''}${oneLine(requirement.title, 120)}`);
    for (const test of requirement.tests) {
      lines.push(`    ${test.outcome.padEnd(7)}${test.optional ? 'optional ' : ''}[${oneLine(test.index, 10)}] ${oneLine(test.name, 120)}${test.outcome === 'UNKNOWN' ? ` (result "${oneLine(test.rawResult, 40)}")` : ''}`);
      if (test.outcome !== 'PASS') {
        if (test.description) lines.push(`        what it checks: ${oneLine(test.description, maxLength)}`);
        for (const message of test.messages.slice(0, maxMessages)) lines.push(`        - ${oneLine(message, maxLength)}`);
        if (test.messages.length > maxMessages) lines.push(`        ... and ${test.messages.length - maxMessages} more messages in the report`);
      }
    }
  }
  for (const problem of report.problems) lines.push(`  NOTE: ${problem}`);
  return lines;
}

/** The parsed report as JSON for the folder of the run: what is above, with the messages cut to a sane size. */
export function reportSummary(report, { file, sha256, bytes }) {
  return {
    schema: 1,
    file,
    sha256,
    bytes,
    overall: report.overall,
    passes: reportPasses(report),
    counts: report.counts,
    problems: report.problems,
    attributes: report.attributes,
    requirements: report.requirements.map((requirement) => ({
      number: requirement.number,
      title: requirement.title,
      tests: requirement.tests.map((test) => ({
        index: test.index,
        name: test.name,
        optional: test.optional,
        outcome: test.outcome,
        rawResult: test.rawResult,
        executionTime: test.executionTime,
        messages: test.messages.slice(0, 50).map((message) => oneLine(message, 1000)),
      })),
    })),
  };
}

/** One entry of the sample report: `[requirement number, title, tests]`, a test being `[index, name, description, optional, result, messages]`. */
const SAMPLE_TESTS = [
  [10, 'Deployment and launch tests', [
    [47, 'App launch', 'App launch tests.', false, 'PASS', []],
    [21, 'Crashes and hangs', 'Do not crash or hang during the testing process.', false, 'PASS', []],
  ]],
  [12, 'Package compliance test', [
    [31, 'App manifest', 'App manifest must include valid entries for all required fields.', false, 'PASS', []],
    [77, 'Application count', 'One package should not define more than one app in the manifest.', false, 'PASS', []],
  ]],
  [15, 'Supported API test', [[38, 'Supported APIs', 'Windows Store App must only use supported platform APIs.', false, 'FAIL', ['API Module32FirstW in kernel32.dll is not supported for this application type. zWorkTracker.exe calls this API.', 'API Module32NextW in kernel32.dll is not supported for this application type. zWorkTracker.exe calls this API.']]]],
  [19, 'App manifest resources tests', [[45, 'App resources', 'The package should have valid resources defined in the resources.pri file.', false, 'PASS', []]]],
  [25, 'Package sanity test', [
    [92, 'Blocked executables', 'Check whether the app launches executables that are blocked on Windows 10 S.', true, 'FAIL', ['File WebView2Loader.dll references the string "cmd".']],
    [93, 'Digitally signed files', 'All PE files in the package should be digitally signed.', true, 'WARN', ['zWorkTracker.exe is not signed.']],
  ]],
];

/**
 * A report in the shape of the real ones, for --dry-run and the tests. `failing` makes the Supported APIs test fail, as in the real report the shape was
 * read from (and the overall result FAIL); without it every required test passes and the overall result is PASS. One optional test fails and one reports
 * WARN either way. The test names are the kit's; the messages and the app are made up.
 */
export function sampleWackReport({ failing = false } = {}) {
  const escape = (text) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
  const requirements = SAMPLE_TESTS.map(([number, title, tests]) => {
    const rows = tests.map(([index, name, description, optional, result, messages]) => {
      const shown = !failing && result === 'FAIL' && !optional ? 'PASS' : result;
      const list = shown === 'PASS' ? [] : messages;
      return [
        `      <TEST INDEX="${index}" NAME="${escape(name)}" DESCRIPTION="${escape(description)}" EXECUTIONTIME="00h:00m:01s.00ms" OPTIONAL="${optional ? 'TRUE' : 'FALSE'}">`,
        list.length === 0 ? '        <MESSAGES />' : ['        <MESSAGES>', ...list.map((text) => `          <MESSAGE TEXT="${escape(text)}" />`), '        </MESSAGES>'].join('\n'),
        `        <RESULT><![CDATA[${shown}]]></RESULT>`,
        '      </TEST>',
      ].join('\n');
    });
    return [`    <REQUIREMENT NUMBER="${number}" TITLE="${escape(title)}" RATIONALE="Made up for the sample.">`, ...rows, '    </REQUIREMENT>'].join('\n');
  });
  return [
    '<?xml version="1.0" encoding="utf-8"?>',
    "<?xml-stylesheet type='text/xsl' href='C:\\ProgramData\\Windows App Certification Kit\\results.xsl'?>",
    `<REPORT xml:lang="en-US" OVERALL_RESULT="${failing ? 'FAIL' : 'PASS'}" VERSION="10.0.28000.2957" LATEST_VERSION="" UPDATE_DOWNLOAD_URL="" TOOLSET_ARCHITECTURE="x64" SecureBoot="FALSE" APP_TYPE="Desktop Bridge" PUBLISHER_DISPLAY_NAME="CN=1DEF8D7B-1D68-4604-8047-048DC92CF3A9" APP_NAME="zWorkTracker" APP_VERSION="1.3.3.0" OSVERSION="10.0.28000.0" OS="Microsoft Windows 11 Pro" PER_USER_APPLICATION="" PARTIAL_RUN="FALSE" LCID="1033" X64_ONLY="FALSE" VALIDATION_TYPE="CommandLine" ReportGenerationTime="11/3/2026 11:59:00 PM" ID="0123456789abcdef0123456789abcdef">`,
    '  <REQUIREMENTS>',
    ...requirements,
    '  </REQUIREMENTS>',
    '  <APPLICATIONS>',
    '    <Installed_Programs>',
    '      <Program Name="PedroMiguelRodriguesJorge.zWorkTracker" Type="Application" Source="AppxPackage" Version="1.3.3.0" />',
    '    </Installed_Programs>',
    '  </APPLICATIONS>',
    '  <DEPENDENCY_INFORMATION>',
    '    <AitStaticAnalysis ProgramId="1" AnalysisVersion="1" Type="Win32">',
    '      <AitFile ErrorCode="0" Name="zWorkTracker.exe" Id="1"><AitCategory Id="1"><AitFeature Name="kernel32.dll!Module32FirstW" /></AitCategory></AitFile>',
    '    </AitStaticAnalysis>',
    '  </DEPENDENCY_INFORMATION>',
    '</REPORT>',
    '',
  ].join('\n');
}

// ---------------------------------------------------------------------------------------------------------------------------------------
// The packages: made again with the indexes, gated, published

/** Runs `command` and collects what it printed, without blocking the server that has to answer the VM meanwhile. Resolves with `{ status, output }`. */
function runAsync(command, args, options) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(command, args, { ...options, stdio: ['ignore', 'pipe', 'pipe'] });
    const parts = [];
    child.stdout.on('data', (part) => parts.push(part));
    child.stderr.on('data', (part) => parts.push(part));
    child.on('error', rejectRun);
    child.on('close', (status) => resolveRun({ status, output: Buffer.concat(parts).toString('utf8') }));
  });
}

/**
 * Packs both packages again, with package-msix.mjs (`--identity both`), into `outDir`, each with the resources.pri named in `indexes` (the files the
 * run saved). The release exe that is there is packed as it is: nothing is built. Returns the file of each package, `{ store, test }`, or rejects with
 * a Failure that holds what package-msix said if it fails or leaves a package out.
 */
export async function buildPackages({ scriptsDir, outDir, indexes, productName, version, env = process.env, say = () => {} }) {
  mkdirSync(outDir, { recursive: true });
  const packEnv = { ...env, ZWT_MSIX_OUT_DIR: outDir, ZWT_MSIX_PRI_STORE: indexes.store, ZWT_MSIX_PRI_TEST: indexes.test };
  const run = await runAsync(process.execPath, [join(scriptsDir, 'package-msix.mjs'), '--identity', 'both'], { cwd: dirname(scriptsDir), env: packEnv });
  if (run.status !== 0) throw new Failure(`package-msix.mjs --identity both failed (exit ${run.status}):\n${tail(run.output, 30)}`);
  const files = Object.fromEntries(KINDS.map((kind) => [kind, join(outDir, msixFileName(productName, version, kind))]));
  for (const file of Object.values(files)) if (!existsSync(file)) throw new Failure(`package-msix.mjs finished and left no ${file}:\n${tail(run.output, 30)}`);
  say(run.output.split('\n').filter((line) => /^(Packing |Package: |Resource index: |Files in the package: )/.test(line)).map((line) => `  ${line}`).join('\n'));
  return files;
}

/**
 * The checks on one built package, from what is read out of it: its file names `entries`, the text of its `manifest`, the resources.pri inside it
 * (`indexInside`) and the one it was made from (`indexExpected`), and the PE `machine` of its exe. A list of `{ ok, what, detail }`; nothing here touches a file.
 * The family name is held to EXPECTED_FAMILY, which is written out by hand, and to the one worked out from the identity.
 */
export function gateChecks({ kind, entries, manifest, indexInside, indexExpected, machine, version }) {
  const identity = identityOf(kind);
  const read = manifestIdentity(manifest);
  const checks = [];
  const check = (ok, what, detail = '') => checks.push({ ok, what, detail });
  const lacking = lackingAssets(entries);
  const images = entries.filter((entry) => entry.startsWith('Assets/'));
  check(lacking.length === 0 && images.length === assetImages().length, `Assets holds the ${assetImages().length} images`, lacking.length > 0 ? `lacking ${lacking.slice(0, 3).join(', ')}${lacking.length > 3 ? ` and ${lacking.length - 3} more` : ''}` : `${images.length} in Assets`);
  check(entries.includes(RESOURCE_INDEX), `${RESOURCE_INDEX} is at the root`, entries.includes(RESOURCE_INDEX) ? '' : 'there is none');
  check(indexInside !== null && indexExpected.equals(indexInside), `the ${RESOURCE_INDEX} inside is the one that was saved`, indexInside === null ? 'there is none' : `${indexInside.length} bytes inside, ${indexExpected.length} saved`);
  check(read.name === identity.name, `Identity Name is ${identity.name}`, `is ${read.name}`);
  check(read.publisher === identity.publisher, `Publisher is ${identity.publisher}`, `is ${read.publisher}`);
  check(read.version === version, `Version is ${version}`, `is ${read.version}`);
  check(read.architecture === 'x64', 'ProcessorArchitecture is x64', `is ${read.architecture}`);
  check(machine === 'x64', 'the exe is an x64 program', `is ${machine ?? 'not a PE file'}`);
  let family = '(not worked out)';
  try {
    family = packageFamilyName(read.name, read.publisher);
  } catch (error) {
    family = error instanceof Error ? error.message : String(error);
  }
  check(family === EXPECTED_FAMILY[kind], `the package family name is ${EXPECTED_FAMILY[kind]}`, `is ${family}`);
  check(!entries.includes('AppxSignature.p7x'), 'the package is unsigned', 'it carries a signature');
  return checks;
}

/** Reads a built package and runs gateChecks on it. `index` is the resources.pri that was put in it. */
export function gatePackage({ kind, file, index, version }) {
  const entries = packageEntries(file);
  const manifest = packageEntry(file, 'AppxManifest.xml');
  const exe = packageEntry(file, 'zWorkTracker.exe');
  return gateChecks({ kind, entries, manifest: manifest === null ? '' : manifest.toString('utf8'), indexInside: packageEntry(file, RESOURCE_INDEX), indexExpected: index, machine: exe === null ? null : peMachine(exe), version });
}

/** The lines that show the checks of a package, and whether they all passed. */
export function gateLines(kind, checks) {
  return { ok: checks.every(({ ok }) => ok), lines: checks.map(({ ok, what, detail }) => `  ${ok ? 'PASS' : 'FAIL'} ${kind}: ${what}${!ok && detail ? ` (${detail})` : ''}`) };
}

/**
 * Puts the two built packages in `publishDir` under the names they are given. A file already there under such a name is renamed first and never deleted or
 * overwritten: one without a resources.pri (the packages 1.3.3 had before the indexes) becomes `<name>.no-pri.msix`, any other `<name>.previous-<stamp>.msix`,
 * and a name taken already gets -2, -3 ... after it. A file that is the same as the new one is left where it is. Nothing else in the folder is touched.
 * The copy is made through a `.partial` file and read back. Returns, for each package, `{ target, sha256, bytes, renamed }`.
 */
export function publishPackages({ built, publishDir, stamp, say = () => {} }) {
  mkdirSync(publishDir, { recursive: true });
  const published = {};
  for (const kind of KINDS) {
    const source = built[kind];
    const name = basename(source);
    const target = join(publishDir, name);
    const sha256 = sha256File(source);
    const renamed = [];
    if (existsSync(target) && sha256File(target) !== sha256) {
      let hasIndex = false;
      try {
        hasIndex = packageEntries(target).includes(RESOURCE_INDEX);
      } catch {
        hasIndex = true;
      }
      const stem = name.replace(/\.msix$/, '');
      const wanted = hasIndex ? `${stem}.previous-${stamp}` : `${stem}.no-pri`;
      let backup = join(publishDir, `${wanted}.msix`);
      for (let number = 2; existsSync(backup); number++) backup = join(publishDir, `${wanted}-${number}.msix`);
      renameSync(target, backup);
      renamed.push({ from: target, to: backup, hadIndex: hasIndex });
      say(`  renamed ${target}\n       to ${backup} (${hasIndex ? 'it had a resources.pri or could not be read' : 'it had no resources.pri'}; kept, not deleted)`);
    }
    if (!existsSync(target)) {
      try {
        copyFileSync(source, `${target}.partial`);
        renameSync(`${target}.partial`, target);
      } catch (error) {
        rmSync(`${target}.partial`, { force: true });
        for (const { from, to } of renamed.reverse()) if (!existsSync(from)) renameSync(to, from);
        throw error;
      }
    }
    if (sha256File(target) !== sha256) throw new Failure(`${target} does not read back as the package that was published.`);
    published[kind] = { target, sha256, bytes: statSync(target).size, renamed };
  }
  return published;
}

// ---------------------------------------------------------------------------------------------------------------------------------------
// The script the VM runs
//
// It is built from the sections of make-pri.mjs (the head, the helpers and the step that makes the indexes, which are the same text in both scripts) and
// the sections below. It is for Windows PowerShell 5.1 and uses nothing else, as the other one: no PowerShell 7 syntax, only ASCII, no parameter block,
// nothing that asks where the script is, and every value the Mac puts in is checked to be plain before it is. It does these things, and stops at the first
// that fails, with a FAIL line, the step and the reason, which it also sends to the Mac (PUT /vm-status.json):
//   administrator; the indexes (skipping what the Mac holds); wait for the Mac (GET /status every 10 seconds); the Windows App Certification Kit (installed
//   from Microsoft's SDK installer, after its Authenticode signature is checked, if appcert.exe is missing); the WACK copy and its certificate; the
//   certificate into LocalMachine\TrustedPeople; appcert.exe reset and test; the report back; the signed test package, if the Mac made one.
// Whatever happened, a `finally` takes the certificate out of TrustedPeople (by its thumbprint) and removes the package the kit installed (by the exact
// name of the Store identity), and sends the Mac one last status that says so.

const MSIX_CONSTANTS = String.raw`  $reportPath = '@@REPORT_PATH@@'
  $vmStatusPath = '@@VM_STATUS_PATH@@'
  $sdkUrl = '@@SDK_URL@@'
  $sdkFeature = '@@SDK_FEATURE@@'
  $storeName = '@@STORE_NAME@@'
  $testName = '@@TEST_NAME@@'
  $testFamily = '@@TEST_FAMILY@@'
  $pollMinutes = @@POLL_MINUTES@@
  $sdkMinutes = @@SDK_MINUTES@@
  $wackMinutes = @@WACK_MINUTES@@

`;

const MSIX_HELPERS = String.raw`  function Write-Info([string]$Text) {
    Write-Host ('     ' + $Text)
  }

  # Tells the Mac what this script is doing, or why it stopped. It never throws: the Mac may be gone, and the script goes on.
  function Send-VmStatus([string]$Step, [string]$State, [string]$Detail, [bool]$Final = $false) {
    try {
      if ($Detail.Length -gt 6000) { $Detail = $Detail.Substring(0, 6000) }
      $note = @{ schema = 1; step = $Step; state = $State; detail = $Detail; final = $Final; at = (Get-Date).ToString('s'); computer = $env:COMPUTERNAME }
      $bytes = [System.Text.Encoding]::UTF8.GetBytes((ConvertTo-Json -InputObject $note -Compress))
      Invoke-WebRequest -UseBasicParsing -Uri ($base + $vmStatusPath) -Method Put -Body $bytes -ContentType 'application/json; charset=utf-8' | Out-Null
    } catch {
      Write-Info ('(could not tell the Mac: ' + $_.Exception.Message + ')')
    }
  }

  function Test-IsAdmin {
    $identity = [System.Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = New-Object System.Security.Principal.WindowsPrincipal($identity)
    return $principal.IsInRole([System.Security.Principal.WindowsBuiltInRole]::Administrator)
  }

  function Get-AppcertPath {
    $folder = [Environment]::GetEnvironmentVariable('ProgramFiles(x86)')
    if ([string]::IsNullOrEmpty($folder)) { $folder = $env:ProgramFiles }
    return (Join-Path $folder 'Windows Kits\10\App Certification Kit\appcert.exe')
  }

  # Deletes a file of this script's own folder, and nothing outside it.
  function Remove-Inside([string]$Path) {
    $full = [System.IO.Path]::GetFullPath($Path)
    if (-not $full.StartsWith($root + '\', [System.StringComparison]::OrdinalIgnoreCase)) {
      throw ('refusing to delete ' + $full + ', which is not inside ' + $root)
    }
    if (Test-Path -LiteralPath $full) {
      Remove-Item -LiteralPath $full -Force
    }
  }

  function Get-LogTail([string]$Path) {
    try {
      if (Test-Path -LiteralPath $Path) {
        $lines = @(Get-Content -LiteralPath $Path -Tail 12)
        return ('The last lines of ' + $Path + ': ' + (($lines | ForEach-Object { $_.ToString().Trim() }) -join ' | '))
      }
    } catch {
    }
    return ('There is no log at ' + $Path + '.')
  }

  # Runs a program and waits for it at most $Minutes minutes, saying once a minute that it is still running. One that is still running when the time is
  # up is stopped and it is a FAIL, never a hang.
  function Invoke-Program([string]$Exe, [string]$Arguments, [int]$Minutes, [string]$What, [bool]$Visible) {
    $options = @{ FilePath = $Exe; ArgumentList = $Arguments; PassThru = $true }
    if ($Visible) { $options['NoNewWindow'] = $true } else { $options['WindowStyle'] = 'Hidden' }
    $process = Start-Process @options
    $null = $process.Handle
    $began = Get-Date
    $limit = $began.AddMinutes($Minutes)
    $lastBeat = $began
    while (-not $process.WaitForExit(15000)) {
      if ((Get-Date) -gt $limit) {
        try { $process.Kill() } catch { }
        throw ($What + ' did not finish within ' + $Minutes + ' minutes and was stopped')
      }
      if (((Get-Date) - $lastBeat).TotalSeconds -ge 60) {
        Write-Info ($What + ' is still running (' + [int](((Get-Date) - $began).TotalMinutes) + ' minutes so far)')
        $lastBeat = Get-Date
      }
    }
    return $process.ExitCode
  }

  # Fetches one file the Mac lists in its status, { name, path, sha256 }, into the folder of this script and checks its SHA-256.
  function Save-MacFile($Item) {
    $name = [string]$Item.name
    $path = [string]$Item.path
    $hash = [string]$Item.sha256
    if ($name -notmatch '^[A-Za-z0-9._-]+$' -or $path -notmatch '^/[A-Za-z0-9._/-]+$' -or $hash -notmatch '^[0-9A-Fa-f]{64}$') {
      throw 'the Mac named a file in a way this script does not accept'
    }
    $target = Join-Path $root $name
    Get-Remote ($base + $path) $target
    Test-Hash $target $hash
    Write-Ok ('fetched ' + $name + ' (' + (Get-Item -LiteralPath $target).Length + ' bytes), SHA-256 matches')
    return $target
  }

`;

// From the top of the work to the step that makes the indexes (VM_SECTIONS.indexStep, which follows it).
const MSIX_TOP = String.raw`  $origin = (Get-Location).Path
  $state = @{ Step = 'start'; Thumb = ''; Wack = $false; Failed = $false }
  try {
    Write-Host ('zWorkTracker: the Windows side of pnpm msix:vm. It works in ' + $root + ', installs the Windows App Certification Kit if it is missing, and takes away what it added to this PC.')
    $arch = $env:PROCESSOR_ARCHITECTURE
    if (-not [string]::IsNullOrEmpty($env:PROCESSOR_ARCHITEW6432)) { $arch = $env:PROCESSOR_ARCHITEW6432 }
    $where = 'Windows ' + [Environment]::OSVersion.Version + ', ' + $arch + ', PowerShell ' + $PSVersionTable.PSVersion
    Write-Info $where
    $state.Step = 'administrator'
    if (-not (Test-IsAdmin)) {
      throw 'this PowerShell is not running as Administrator, which the certificate store and the Windows App Certification Kit need. Close it, open Windows PowerShell with a right click and Run as administrator, and type the line again.'
    }
    Write-Ok 'running as Administrator'
    New-Item -ItemType Directory -Force -Path $root | Out-Null
    Send-VmStatus 'start' 'OK' $where

    $state.Step = 'resources.pri'
`;

// From the end of the step that makes the indexes to the end of the script.
const MSIX_REST = String.raw`    Send-VmStatus 'resources.pri' 'OK' 'both resources.pri are on the Mac'

    $state.Step = 'waiting for the Mac'
    Write-Host 'The Mac is packing both packages with the new resources.pri and making the copy of the Store package that only the Windows App Certification Kit will trust. Waiting for it ...'
    $started = Get-Date
    $deadline = $started.AddMinutes($pollMinutes)
    $lastPhase = ''
    $lastNote = $started
    while ($true) {
      $mac = Get-MacStatus
      if ($null -ne $mac.error) { throw ('the Mac could not get the packages ready: ' + $mac.error) }
      if ($mac.wack.ready) { break }
      $phase = [string]$mac.phase
      $elapsed = [int](((Get-Date) - $started).TotalSeconds)
      if ($phase -ne $lastPhase -or ((Get-Date) - $lastNote).TotalSeconds -ge 60) {
        Write-Info ($phase + ' (' + $elapsed + ' seconds)')
        $lastPhase = $phase
        $lastNote = Get-Date
      }
      if ((Get-Date) -gt $deadline) { throw ('the Mac did not have the packages ready within ' + $pollMinutes + ' minutes; it says: ' + $phase) }
      Start-Sleep -Seconds 10
    }
    Write-Ok 'the Mac has the packages ready'

    $state.Step = 'Windows App Certification Kit'
    $appcert = Get-AppcertPath
    if (Test-Path -LiteralPath $appcert) {
      Write-Ok ('the Windows App Certification Kit is installed already: ' + $appcert)
    } else {
      Write-Info ('This PC is ' + $arch + '. The Windows App Certification Kit is not installed, so Microsoft''s installer of the Windows SDK is fetched and run for that one feature, ' + $sdkFeature + '.')
      if ($arch -eq 'ARM64') {
        Write-Info 'This is Windows on Arm64. Microsoft documents no Arm64 build of the kit and the SDK installer may not lay it down here: it is tried, and if appcert.exe is not there afterwards that is a FAIL that says so.'
      }
      $setup = Join-Path $root 'winsdksetup.exe'
      Remove-Inside $setup
      try {
        Invoke-WebRequest -UseBasicParsing -Uri $sdkUrl -OutFile $setup | Out-Null
      } catch {
        throw ('could not download ' + $sdkUrl + ': ' + (Get-ErrorDetail $_))
      }
      $size = (Get-Item -LiteralPath $setup).Length
      if ($size -lt 500000 -or $size -gt 20000000) {
        throw ('what ' + $sdkUrl + ' sent is ' + $size + ' bytes, which is not the installer of the Windows SDK; it was not run')
      }
      $signature = Get-AuthenticodeSignature -FilePath $setup
      if ($signature.Status -ne 'Valid') {
        throw ('the downloaded winsdksetup.exe has no valid Authenticode signature (' + $signature.Status + ': ' + $signature.StatusMessage + '); it was not run')
      }
      $signer = $signature.SignerCertificate.Subject
      if ($signer -notmatch '(^|, )O=Microsoft Corporation(,|$)') {
        throw ('the downloaded winsdksetup.exe is signed by ' + $signer + ' and not by Microsoft Corporation; it was not run')
      }
      Write-Ok ('winsdksetup.exe (' + $size + ' bytes): Authenticode signature Valid, signed by ' + $signer)
      $log = Join-Path $root 'winsdksetup.log'
      $arguments = '/features ' + $sdkFeature + ' /quiet /norestart /ceip off /log ' + $log
      Write-Info ('winsdksetup.exe ' + $arguments)
      Write-Info 'It downloads and installs only that feature, which takes some minutes, and shows nothing while it does. A quiet install of the Windows SDK accepts its license terms.'
      Send-VmStatus 'Windows App Certification Kit' 'INFO' 'the Windows SDK installer has started'
      $code = Invoke-Program $setup $arguments $sdkMinutes 'the Windows SDK installer' $false
      if ($code -ne 0 -and $code -ne 3010) {
        throw ('winsdksetup.exe ended with the exit code ' + $code + '. ' + (Get-LogTail $log))
      }
      $waited = 0
      while (-not (Test-Path -LiteralPath $appcert) -and $waited -lt 120) {
        Start-Sleep -Seconds 5
        $waited += 5
      }
      if (-not (Test-Path -LiteralPath $appcert)) {
        $why = 'winsdksetup.exe ended with the exit code ' + $code + ' and appcert.exe is not at ' + $appcert + '.'
        if ($arch -eq 'ARM64') {
          $why = $why + ' This PC is Windows on Arm64: Microsoft documents no Arm64 build of the kit, and GitHub''s windows-11-arm images have the Windows SDK with no appcert.exe either. The kit has to be run on an x64 Windows PC.'
        }
        throw ($why + ' ' + (Get-LogTail $log))
      }
      Write-Ok ('the Windows App Certification Kit is installed: ' + $appcert)
    }
    Send-VmStatus 'Windows App Certification Kit' 'OK' $appcert

    $state.Step = 'fetching the WACK copy'
    $wackPackage = Save-MacFile $mac.wack.package
    $wackCertificate = Save-MacFile $mac.wack.certificate
    $thumb = ([string]$mac.wack.certificate.thumbprint).ToUpper()
    if ($thumb -notmatch '^[0-9A-F]{40}$') {
      throw 'the Mac sent a certificate thumbprint that is not 40 hexadecimal digits'
    }

    $state.Step = 'trusting the WACK-only certificate'
    $present = @(Get-AppxPackage -Name $storeName | Where-Object { $_.Name -eq $storeName })
    if ($present.Count -gt 0) {
      throw ('a package with the Store identity is installed on this PC already (' + $present[0].PackageFullName + '). The kit installs one and this script removes it again, and removing it would delete its data: remove it yourself first, with Remove-AppxPackage, if you do not need it.')
    }
    $state.Thumb = $thumb
    $imported = Import-Certificate -FilePath $wackCertificate -CertStoreLocation 'Cert:\LocalMachine\TrustedPeople'
    if ($imported.Thumbprint -ne $thumb) {
      throw ('the certificate that was imported has the thumbprint ' + $imported.Thumbprint + ', and the Mac said ' + $thumb)
    }
    Write-Ok ('the WACK-only certificate ' + $thumb + ' is trusted in LocalMachine\TrustedPeople, until this script ends')
    try {
      $copy = Get-AuthenticodeSignature -FilePath $wackPackage
      Write-Info ('the signature of the WACK copy, as this PC sees it: ' + $copy.Status)
    } catch {
      Write-Info ('(the signature of the WACK copy could not be read: ' + $_.Exception.Message + ')')
    }

    $state.Step = 'appcert.exe'
    $state.Wack = $true
    Write-Info 'appcert.exe reset'
    $code = Invoke-Program $appcert 'reset' 5 'appcert.exe reset' $true
    if ($code -ne 0) {
      throw ('appcert.exe reset ended with the exit code ' + $code)
    }
    $report = Join-Path $root 'wack-report.xml'
    Remove-Inside $report
    $testArguments = 'test -appxpackagepath ' + $wackPackage + ' -reportoutputpath ' + $report
    Write-Info ('appcert.exe ' + $testArguments)
    Write-Info 'The kit installs the package, starts the app and drives it, for ten to thirty minutes. Leave this PC alone until the next OK.'
    Send-VmStatus 'appcert.exe' 'INFO' 'appcert.exe test has started'
    $code = Invoke-Program $appcert $testArguments $wackMinutes 'appcert.exe test' $true
    if (-not (Test-Path -LiteralPath $report)) {
      throw ('appcert.exe test ended with the exit code ' + $code + ' and wrote no report at ' + $report)
    }
    Write-Ok ('appcert.exe test ended with the exit code ' + $code + ' and wrote ' + $report + ' (' + (Get-Item -LiteralPath $report).Length + ' bytes)')

    $state.Step = 'sending the report'
    try {
      $reply = Invoke-WebRequest -UseBasicParsing -Uri ($base + $reportPath) -Method Put -InFile $report -ContentType 'application/xml'
    } catch {
      throw ('could not send the report to the Mac: ' + (Get-ErrorDetail $_) + ' (it stays at ' + $report + ')')
    }
    Write-Ok ('the report is on the Mac (' + ([string]$reply.Content).Trim() + ')')
    Send-VmStatus 'report' 'OK' 'the report was sent'

    if ($null -ne $mac.testPackage) {
      $state.Step = 'test package'
      $testFile = Save-MacFile $mac.testPackage
      $testSigner = ([string]$mac.testPackage.signerThumbprint).ToUpper()
      if ($testSigner -notmatch '^[0-9A-F]{40}$') {
        throw 'the Mac sent a thumbprint for the test package that is not 40 hexadecimal digits'
      }
      $trusted = @(Get-ChildItem -LiteralPath 'Cert:\LocalMachine\TrustedPeople' | Where-Object { $_.Thumbprint -eq $testSigner })
      if ($trusted.Count -eq 0) {
        throw ('the test package is signed with the certificate ' + $testSigner + ' (' + [string]$mac.testPackage.signerSubject + '), which is not in LocalMachine\TrustedPeople on this PC. Import it as for the earlier test packages (INSTALL-MSIX-TEST.txt, step 3), and type the line again.')
      }
      Write-Info 'Add-AppxPackage of the signed test package (an upgrade of the one that is installed, if there is one)'
      Add-AppxPackage -Path $testFile -ForceUpdateFromAnyVersion
      $installed = @(Get-AppxPackage -Name $testName | Where-Object { $_.Name -eq $testName })
      if ($installed.Count -ne 1) {
        throw ('after Add-AppxPackage there are ' + $installed.Count + ' packages named ' + $testName + ', and there should be one')
      }
      $package = $installed[0]
      if ($package.PackageFamilyName -ne $testFamily) {
        throw ('the installed test package has the family name ' + $package.PackageFamilyName + ', and it should be ' + $testFamily)
      }
      Write-Ok ('installed ' + $package.PackageFullName)
      $manifest = $package | Get-AppxPackageManifest
      $appId = [string]@($manifest.Package.Applications.Application)[0].Id
      if ($appId -notmatch '^[A-Za-z0-9._-]+$') {
        throw 'the manifest of the installed test package names no usable application id'
      }
      Start-Process -FilePath ('shell:AppsFolder\' + $package.PackageFamilyName + '!' + $appId)
      Write-Ok ('started ' + $package.PackageFamilyName + '!' + $appId)
      Write-Host 'LOOK AT THE APP NOW (the test package):' -ForegroundColor Cyan
      Write-Host '  - the taskbar button and the Start entry: the logo should have NO plate behind it' -ForegroundColor Cyan
      Write-Host '  - the tray icon, by the clock: the round clock' -ForegroundColor Cyan
      Send-VmStatus 'test package' 'OK' ('installed and started ' + $package.PackageFullName)
    } else {
      Write-Info 'The Mac made no signed test package (ZWT_TEST_PFX and ZWT_TEST_PFX_PASS_FILE), so none is installed.'
    }

    $state.Step = 'finished'
    Write-Ok 'every step is done. The Mac has the report and prints what it says.'
    $global:LASTEXITCODE = 0
  } catch {
    $state.Failed = $true
    $reason = $_.Exception.Message
    Write-Host ('FAIL [' + $state.Step + '] ' + $reason) -ForegroundColor Red
    Send-VmStatus $state.Step 'FAIL' $reason
    $global:LASTEXITCODE = 1
  } finally {
    $cleanup = @()
    $cleanFailed = $false
    if ($state.Thumb -ne '') {
      try {
        $location = 'Cert:\LocalMachine\TrustedPeople'
        foreach ($cert in @(Get-ChildItem -LiteralPath $location | Where-Object { $_.Thumbprint -eq $state.Thumb })) {
          Remove-Item -LiteralPath ($location + '\' + $cert.Thumbprint) -Force
        }
        $still = @(Get-ChildItem -LiteralPath $location | Where-Object { $_.Thumbprint -eq $state.Thumb })
        if ($still.Count -gt 0) { throw 'it is still in the store' }
        $line = 'the WACK-only certificate ' + $state.Thumb + ' was removed from TrustedPeople'
        $cleanup += $line
        Write-Ok $line
      } catch {
        $cleanFailed = $true
        $line = 'COULD NOT REMOVE the certificate ' + $state.Thumb + ' from TrustedPeople (' + $_.Exception.Message + '); remove it with: Remove-Item Cert:\LocalMachine\TrustedPeople\' + $state.Thumb
        $cleanup += $line
        Write-Host ('FAIL ' + $line) -ForegroundColor Red
      }
    }
    if ($state.Wack) {
      try {
        $left = @(Get-AppxPackage -Name $storeName | Where-Object { $_.Name -eq $storeName })
        foreach ($package in $left) {
          Remove-AppxPackage -Package $package.PackageFullName
        }
        $after = @(Get-AppxPackage -Name $storeName | Where-Object { $_.Name -eq $storeName })
        if ($after.Count -gt 0) { throw ($after[0].PackageFullName + ' is still installed') }
        if ($left.Count -gt 0) {
          $line = 'the package ' + $left[0].PackageFullName + ', which the kit installed, was removed'
        } else {
          $line = 'no package with the Store identity was left installed'
        }
        $cleanup += $line
        Write-Ok $line
      } catch {
        $cleanFailed = $true
        $line = 'COULD NOT REMOVE the package named ' + $storeName + ' (' + $_.Exception.Message + '); remove it with: Get-AppxPackage -Name ' + $storeName + ' | Remove-AppxPackage'
        $cleanup += $line
        Write-Host ('FAIL ' + $line) -ForegroundColor Red
      }
    }
    $summary = $cleanup -join '; '
    if ($summary.Length -eq 0) { $summary = 'nothing was added to this PC that needed taking away' }
    $endState = 'OK'
    if ($cleanFailed -or $state.Failed) { $endState = 'FAIL' }
    Send-VmStatus 'cleanup' $endState $summary $true
    Set-Location -LiteralPath $origin
  }
}
`;

const URL_PLAIN = /^https:\/\/[A-Za-z0-9.]+\/[A-Za-z0-9._/?=-]+$/;
const NUMBER_PLAIN = /^\d{1,3}$/;

/**
 * The PowerShell script the VM runs for `pnpm msix:vm`, as text. The same arguments as buildVmScript of make-pri.mjs: where the Mac serves (`baseUrl`), the line
 * typed (only named in a comment), the SHA-256 of both makepri.exe (`tools`) and of every file of both folders (`files`), and the images the dump of an index must list.
 */
export function buildMsixVmScript({ baseUrl, tools, files, unplated, line }) {
  const fill = {
    ...scriptFills({
      baseUrl,
      tools,
      files,
      unplated,
      line,
      what: 'the Windows side of pnpm msix:vm: makes the two resources.pri, then runs the Windows App Certification Kit on a WACK-only copy of the Store package, and sends the Mac what it finds.',
      scope: `Windows PowerShell 5.1 as Administrator. It writes in ${VM_DIRECTORY}, adds one certificate to LocalMachine\\TrustedPeople and removes it again, and installs the Windows App Certification Kit if it is missing.`,
    }),
    '@@REPORT_PATH@@': plain(REPORT_PATH, 'the report path'),
    '@@VM_STATUS_PATH@@': plain(VM_STATUS_PATH, 'the status path'),
    '@@SDK_URL@@': plain(SDK_INSTALLER_URL, 'the link to the SDK installer', URL_PLAIN),
    '@@SDK_FEATURE@@': plain(SDK_FEATURE, 'the SDK feature'),
    '@@STORE_NAME@@': plain(identityOf('store').name, 'the Store package name'),
    '@@TEST_NAME@@': plain(identityOf('test').name, 'the test package name'),
    '@@TEST_FAMILY@@': plain(EXPECTED_FAMILY.test, 'the test package family name'),
    '@@POLL_MINUTES@@': plain(String(VM_POLL_MINUTES), 'the polling time', NUMBER_PLAIN),
    '@@SDK_MINUTES@@': plain(String(VM_SDK_MINUTES), 'the installer time', NUMBER_PLAIN),
    '@@WACK_MINUTES@@': plain(String(VM_WACK_MINUTES), 'the kit time', NUMBER_PLAIN),
  };
  return fillScript(VM_SECTIONS.head + MSIX_CONSTANTS + VM_SECTIONS.helpers + MSIX_HELPERS + MSIX_TOP + VM_SECTIONS.indexStep + MSIX_REST, fill);
}

// ---------------------------------------------------------------------------------------------------------------------------------------
// The server's checks on what the VM sends

/** What is wrong with `bytes` as the status the VM sends (null if nothing): a small JSON object with a step, a state of OK, FAIL or INFO, and text for the rest. */
export function vmStatusProblem(_kind, bytes) {
  let value;
  try {
    value = JSON.parse(bytes.toString('utf8'));
  } catch {
    return 'it is not JSON';
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return 'it is not a JSON object';
  if (typeof value.step !== 'string' || value.step === '' || value.step.length > 120) return 'it has no step, a short text';
  if (!['OK', 'FAIL', 'INFO'].includes(value.state)) return 'its state is not OK, FAIL or INFO';
  for (const field of ['detail', 'at', 'computer']) if (value[field] !== undefined && typeof value[field] !== 'string') return `its ${field} is not text`;
  if (value.final !== undefined && typeof value.final !== 'boolean') return 'its final is not true or false';
  return null;
}

/**
 * What the server takes for each of the four names, over its defaults (an index: 2 MB and checked as an index; see make-pri.mjs): the report is at most
 * REPORT_LIMIT bytes and is looked at when it has arrived, not before, so that a report that cannot be read is still kept; the status is at most VM_STATUS_LIMIT,
 * must pass vmStatusProblem, and replaces the one before.
 */
export const VM_UPLOAD_RULES = Object.freeze({
  report: Object.freeze({ limit: REPORT_LIMIT, validate: () => null }),
  status: Object.freeze({ limit: VM_STATUS_LIMIT, replace: true, validate: vmStatusProblem }),
});

/** The status the VM sent, as a plain object with every text made one safe line. */
export function readVmStatus(bytes) {
  const value = JSON.parse(bytes.toString('utf8'));
  return {
    step: oneLine(value.step, 120),
    state: value.state,
    detail: oneLine(value.detail ?? '', 4000),
    final: value.final === true,
    at: oneLine(value.at ?? '', 40),
    computer: oneLine(value.computer ?? '', 40),
  };
}

// ---------------------------------------------------------------------------------------------------------------------------------------
// The run

/** `YYYYMMDD-HHMM` of a date, in local time: the name of the folder of a run. */
export function stampOf(date) {
  const pad = (number) => String(number).padStart(2, '0');
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}`;
}

/** Makes the folder `parent/name`, or `parent/name-2`, `-3` ... if that is taken, and returns it. Nothing that was there is touched. */
export function uniqueDir(parent, name) {
  mkdirSync(parent, { recursive: true });
  for (let number = 1; ; number++) {
    const dir = join(parent, number === 1 ? name : `${name}-${number}`);
    try {
      mkdirSync(dir);
      return dir;
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
    }
  }
}


const scriptsDir = import.meta.dirname;
const repoRoot = resolve(scriptsDir, '..');

/**
 * Plays the VM against the server, for --dry-run: asks for the script and the files, tries the doors that must stay shut, sends made-up indexes, waits for the
 * Mac to get the packages ready, fetches the WACK copy and its certificate as the script would, sends progress, a sample report and the last status. Returns
 * `{ passed, failed }`, lists of lines. It asks and sends nothing the script on the VM does not, and a few things it must not.
 */
async function playVm({ where, script, tools, folders, sample, publisher }) {
  const passed = [];
  const failed = [];
  const check = async (what, run) => {
    try {
      const detail = await run();
      passed.push(detail ? `${what} (${detail})` : what);
      return true;
    } catch (error) {
      failed.push(`${what}: ${error instanceof Error ? error.message : String(error)}`);
      return false;
    }
  };
  const must = (condition, message) => {
    if (!condition) throw new Error(message);
  };
  const ask = (path, options = {}) => exchange(where, { method: 'GET', path, ...options });
  const put = (path, body, headers) => exchange(where, { method: 'PUT', path, body, headers });
  const json = (answer) => JSON.parse(answer.body.toString('utf8'));
  const note = (state, step, detail = '', final = false) => JSON.stringify({ schema: 1, step, state, detail, final, at: new Date().toISOString(), computer: 'dry-run' });

  await check('GET /d.ps1 is the script, plain ASCII, and names this server', async () => {
    const answer = await ask(SCRIPT_PATH);
    must(answer.status === 200 && answer.body.equals(Buffer.from(script, 'utf8')), `status ${answer.status}`);
    must(String(answer.headers['content-type']).startsWith('text/plain'), `content-type ${answer.headers['content-type']}`);
    must(/^[\x09\x0a\x20-\x7e]+$/.test(script) && script.includes(`$base = 'http://${where.host}:${where.port}'`), 'not ASCII, or it names another address');
    return `${answer.body.length} bytes`;
  });
  await check('GET /status says nothing has arrived and nothing is ready', async () => {
    const state = json(await ask(STATUS_PATH));
    must(state.schema === 1 && state.pri.store === null && state.pri.test === null, JSON.stringify(state.pri));
    must(state.wack.ready === false && state.testPackage === null && state.report === null && state.error === null && typeof state.phase === 'string', JSON.stringify(state));
    return state.phase;
  });
  await check('GET of a package image and of the store manifest has the SHA-256 the script names', async () => {
    const image = folders.store.find(({ path }) => path.endsWith('_altform-unplated.png') && path.includes('targetsize-16'));
    const answer = await ask(`/store/${image.path}`);
    must(answer.status === 200 && sha256Of(answer.body) === image.sha256, `status ${answer.status}`);
    const manifest = folders.store.find(({ path }) => path === 'AppxManifest.xml');
    const second = await ask('/store/AppxManifest.xml');
    must(second.status === 200 && sha256Of(second.body) === manifest.sha256, `manifest status ${second.status}`);
  });
  for (const arch of ['arm64', 'x64']) {
    await check(`GET of makepri.exe for ${arch} has the SHA-256 the script names`, async () => {
      const answer = await ask(`/makepri-${arch}.exe`);
      must(answer.status === 200 && sha256Of(answer.body) === tools[arch].sha256, `status ${answer.status}`);
      return `${answer.body.length} bytes`;
    });
  }
  const shut = [
    ['GET a path with .. in it', { path: '/store/Assets/../../d.ps1' }, 404],
    ['GET a path with %2e%2e in it', { path: '/store/Assets/%2e%2e/AppxManifest.xml' }, 404],
    ['GET the folder of the WACK files (no listing)', { path: `${SERVED_DIRECTORY}/` }, 404],
    ['GET the WACK copy before it is ready', { path: `${SERVED_DIRECTORY}/zWorkTracker_1.3.3.0_x64_store-wack.msix` }, 404],
    ['PUT to a name that is not one of the four', { method: 'PUT', path: '/other.xml', body: Buffer.from('x') }, 404],
    ['PUT to a file that is served', { method: 'PUT', path: SCRIPT_PATH, body: Buffer.from('x') }, 405],
    ['POST to the status', { method: 'POST', path: STATUS_PATH, body: Buffer.from('x') }, 405],
    ['GET of the name of the report', { path: REPORT_PATH }, 405],
    ['GET of the name of the VM status', { path: VM_STATUS_PATH }, 405],
    ['PUT of an index with a Content-Length over 2 MB', { method: 'PUT', path: UPLOAD_PATHS.store, headers: { 'Content-Length': String(2 * 1024 * 1024 + 1) } }, 413],
    ['PUT of a report with a Content-Length over 5 MB', { method: 'PUT', path: REPORT_PATH, headers: { 'Content-Length': String(REPORT_LIMIT + 1) } }, 413],
    ['PUT of a VM status with a Content-Length over 64 KB', { method: 'PUT', path: VM_STATUS_PATH, headers: { 'Content-Length': String(VM_STATUS_LIMIT + 1) } }, 413],
    ['PUT of something that is not an index', { method: 'PUT', path: UPLOAD_PATHS.store, body: Buffer.from('<html>not found</html>') }, 422],
    ['PUT of the index of the other package', { method: 'PUT', path: UPLOAD_PATHS.store, body: sample.test }, 422],
    ['PUT of a VM status that is not JSON', { method: 'PUT', path: VM_STATUS_PATH, body: Buffer.from('plain text') }, 422],
    ['PUT of a VM status with a state that is not one', { method: 'PUT', path: VM_STATUS_PATH, body: Buffer.from(note('MAYBE', 'x')) }, 422],
  ];
  for (const [what, request, status] of shut) {
    await check(`${what} is refused with ${status}`, async () => {
      const answer = await exchange(where, { method: 'GET', ...request });
      must(answer.status === status, `answered ${answer.status}`);
    });
  }
  await check('the reason an index is refused is in the answer, and not only the number', async () => {
    const answer = await put(UPLOAD_PATHS.store, Buffer.from('<html>not found</html>'));
    must(answer.status === 422 && answer.body.toString().includes('it is not a PRI file'), `${answer.status}: ${answer.body.toString().slice(0, 100)}`);
  });
  await check('PUT of the Store index is kept, and /status says so', async () => {
    const answer = await put(UPLOAD_PATHS.store, sample.store);
    must(answer.status === 201, `answered ${answer.status}: ${answer.body.toString()}`);
    const state = json(await ask(STATUS_PATH));
    must(state.pri.store?.sha256 === sha256Of(sample.store) && state.pri.test === null, JSON.stringify(state.pri));
  });
  await check('the same Store index again is 200 and another is 409', async () => {
    const again = await put(UPLOAD_PATHS.store, sample.store);
    const other = await put(UPLOAD_PATHS.store, Buffer.concat([sample.store, Buffer.from('x')]));
    must(again.status === 200 && other.status === 409, `${again.status} and ${other.status}`);
  });
  await check('PUT of the test index is kept', async () => {
    const answer = await put(UPLOAD_PATHS.test, sample.test);
    must(answer.status === 201, `answered ${answer.status}: ${answer.body.toString()}`);
  });
  let ready = null;
  await check('the Mac packs, checks, publishes and signs, and /status says the WACK copy is ready', async () => {
    const deadline = Date.now() + 180_000;
    let state = json(await ask(STATUS_PATH));
    while (!state.wack.ready && state.error === null && Date.now() < deadline) {
      await new Promise((done) => setTimeout(done, 250));
      state = json(await ask(STATUS_PATH));
    }
    must(state.error === null, `the Mac says: ${state.error}`);
    must(state.wack.ready === true, `not ready after 180 seconds; it says: ${state.phase}`);
    ready = state;
    return state.phase;
  });
  if (ready !== null) {
    const status = ready;
    await check('/status names the WACK copy, its certificate and the two published packages, with SHA-256 and sizes', async () => {
      must(/^[0-9A-F]{40}$/.test(status.wack.certificate.thumbprint), `thumbprint ${status.wack.certificate.thumbprint}`);
      must(status.wack.certificate.subject === publisher, `subject ${status.wack.certificate.subject}`);
      for (const item of [status.wack.package, status.wack.certificate]) must(/^[A-Za-z0-9._-]+$/.test(item.name) && item.path === `${SERVED_DIRECTORY}/${item.name}` && /^[0-9a-f]{64}$/.test(item.sha256) && item.bytes > 0, JSON.stringify(item));
      for (const kind of KINDS) must(status.packages?.[kind]?.sha256?.length === 64, `packages.${kind}`);
      return `${status.wack.package.name}, ${status.wack.package.bytes} bytes`;
    });
    for (const [what, item] of [['the WACK copy', status.wack.package], ['its certificate', status.wack.certificate]]) {
      await check(`GET of ${what} is the file /status describes`, async () => {
        const answer = await ask(item.path);
        must(answer.status === 200 && answer.body.length === item.bytes && sha256Of(answer.body) === item.sha256, `status ${answer.status}, ${answer.body.length} bytes`);
        if (item === status.wack.certificate) must(new X509Certificate(answer.body).fingerprint.replaceAll(':', '') === item.thumbprint, 'the thumbprint of the file is not the one /status gives');
      });
    }
    await check('a name under /wack that is not served is 404', async () => must((await ask(`${SERVED_DIRECTORY}/other.msix`)).status === 404, 'served'));
    await check('the VM tells the Mac what it is doing (PUT /vm-status.json twice: each replaces the one before), and /status shows the last', async () => {
      must((await put(VM_STATUS_PATH, Buffer.from(note('INFO', 'appcert.exe', 'dry run: appcert.exe test has started')))).status === 201, 'first');
      must((await put(VM_STATUS_PATH, Buffer.from(note('OK', 'appcert.exe', 'dry run: appcert.exe test ended')))).status === 201, 'second');
      const state = json(await ask(STATUS_PATH));
      must(state.vm?.step === 'appcert.exe' && state.vm.state === 'OK' && state.vm.final === false, JSON.stringify(state.vm));
    });
    await check('the VM sends the sample report: kept (201), the same again is 200', async () => {
      const report = Buffer.from(sampleWackReport());
      must((await put(REPORT_PATH, report)).status === 201, 'first');
      must((await put(REPORT_PATH, report)).status === 200, 'again');
      const state = json(await ask(STATUS_PATH));
      must(state.report?.sha256 === sha256Of(report) && state.report.bytes === report.length, JSON.stringify(state.report));
    });
    await check('the VM says it has finished, its clean-up done (the last status): the server stops', async () => {
      const answer = await put(VM_STATUS_PATH, Buffer.from(note('OK', 'cleanup', 'dry run: nothing to take away', true)));
      must(answer.status === 201, `answered ${answer.status}`);
    });
  }
  return { passed, failed };
}

/**
 * Runs the whole job. Returns the exit status: 0 when the report arrived, passes, and the VM finished and cleaned up; 2 when the report arrived and its overall
 * result is not PASS; 1 for anything else (a time that ran out, Ctrl-C, a step that failed on the Mac or in the VM, a report that cannot be read). `root` is the
 * repo, where packaging/ goes; `signal` stops the run as Ctrl-C does; `linger` is how long, in minutes, the Mac waits for the VM to say it has finished.
 */
export async function run(argv, { env = process.env, say: write = console.log, root = repoRoot, signal, now = () => new Date(), linger = LINGER_MINUTES } = {}) {
  const options = parseOptions(argv);
  if (options.help) {
    write(helpText());
    return 0;
  }
  const dry = options.dryRun;
  const host = dry ? '127.0.0.1' : options.host;
  const port = dry ? 0 : options.port;
  const early = [];
  let logFile = null;
  const say = (line) => {
    write(line);
    if (logFile === null) early.push(line);
    else appendFileSync(logFile, `${line}\n`);
  };
  if (dry && (options.host !== DEFAULT_HOST || options.port !== DEFAULT_PORT)) say('--dry-run serves on 127.0.0.1 on a free port, so --host and --port are not used.');
  if (dry && options.publishDir !== null) say('--dry-run publishes into a temporary folder and never in a real one, so --publish-dir is not used.');

  // Before any work, so that what is missing is said at once and not after a download: the address and the port (nothing is stopped to make room), and the tools.
  if (!dry) await checkCanListen(host, port);
  const signing = { openssl: findOpenssl(env), osslsigncode: findOsslsigncode(env) };
  for (const tool of [SIPS, UNZIP]) if (!existsSync(tool)) throw new Failure(`Missing ${tool}. This script runs on macOS, which includes it.`);

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
  const stamp = stampOf(now());
  const keepOutput = !(dry && options.outDir === null);
  const parent = keepOutput ? resolve(options.outDir ?? join(root, '.stack', 'out', 'msix-vm')) : mkdtempSync(join(tmpdir(), 'zwt-msix-vm-dry-'));
  try {
    const jobDir = uniqueDir(parent, stamp);
    logFile = join(jobDir, 'msix-vm.log');
    writeFileSync(logFile, `${early.join('\n')}${early.length > 0 ? '\n' : ''}`);
    const priDir = resolve(options.priDir ?? (dry ? join(jobDir, 'vm-files') : join(cargoTargetRoot(tauriDir, env), 'msix-pri')));
    const toolsDir = resolve(options.toolsDir ?? join(homedir(), 'msix-build', 'tools', 'sdk-buildtools'));
    const publishDir = dry ? join(jobDir, 'msix-build') : resolve(options.publishDir ?? join(homedir(), 'msix-build'));
    const installRoot = dry ? join(jobDir, 'dry-run-install') : root;
    const packagingBefore = existsSync(join(root, 'packaging'));

    say(`${dry ? 'Dry run: ' : ''}the Windows side of the Store package job for ${conf.productName} ${conf.version} (package version ${version}). This run's folder: ${jobDir}`);
    say(`Tools: ${signing.openssl.version} (${signing.openssl.path}); osslsigncode ${signing.osslsigncode.version} (${signing.osslsigncode.path})`);
    mkdirSync(priDir, { recursive: true });
    stageFolders({ outDir: priDir, icon: join(tauriDir, 'icons', 'icon.png'), productName: conf.productName, description: conf.bundle.shortDescription, version });
    const folders = readFolders(priDir);
    say(`Folders for the VM in ${priDir}: ${KINDS.map((kind) => `${kind}/ (${folders[kind].length} files)`).join(', ')}`);

    const makepri = await ensureMakepri({ toolsDir, sdkVersion: options.sdkVersion, dotnet: options.dotnet, env, say });
    const tools = Object.fromEntries(['arm64', 'x64'].map((arch) => [arch, { ...makepri.tools[arch], bytes: readFileSync(makepri.tools[arch].file) }]));
    for (const arch of ['arm64', 'x64']) {
      if (sha256Of(tools[arch].bytes) !== makepri.tools[arch].sha256) throw new Failure(`${makepri.tools[arch].file} changed after it was checked.`);
    }
    say(`makepri from ${PACKAGE_ID} ${makepri.version}${makepri.reused ? ' (kept)' : ''}: arm64 SHA-256 ${makepri.tools.arm64.sha256}, x64 SHA-256 ${makepri.tools.x64.sha256}`);

    const routes = buildRoutes({ folders, tools });
    const controller = new AbortController();
    const onSignal = () => controller.abort();
    process.once('SIGINT', onSignal);
    process.once('SIGTERM', onSignal);
    if (signal?.aborted) controller.abort();
    else signal?.addEventListener('abort', onSignal, { once: true });

    // ---- the state of the job, and what each thing the VM sends does to it
    const state = { phase: 'waiting for the two resources.pri', error: null, packages: null, wack: { ready: false, package: null, certificate: null }, testPackage: null, report: null, vm: null };
    const result = { saved: null, built: null, published: null, wack: null, testSigned: null, reportFile: null, report: null, reportError: null, vmFailure: null, vmFinal: null, pipelineError: null, unsignedBefore: null, unsignedAfter: null };
    let serving = null;
    let pipelineStarted = false;
    let lingerTimer = null;
    const statusJson = () => ({ schema: 1, job: stamp, phase: state.phase, error: state.error, pri: priStatus(serving.snapshot().received), packages: state.packages, wack: state.wack, testPackage: state.testPackage, report: state.report, vm: state.vm });

    const stopNow = (why) => {
      clearTimeout(lingerTimer);
      serving.stop(why);
    };
    const waitForTheVm = (minutes, why) => {
      clearTimeout(lingerTimer);
      lingerTimer = setTimeout(() => {
        say('');
        say(`The VM did not say it had finished within ${minutes} minutes of the last news from it. Stopping here.`);
        serving.stop(why);
      }, minutes * 60_000);
    };
    const maybeStop = () => {
      const failed = result.vmFailure !== null || result.pipelineError !== null;
      if (result.vmFinal !== null && (result.report !== null || result.reportError !== null || failed)) stopNow(failed ? 'failed' : 'complete');
    };

    const serve = (file, type) => {
      const name = basename(file);
      const path = `${SERVED_DIRECTORY}/${name}`;
      routes.set(path, { body: readFileSync(file), type });
      return { name, path, bytes: statSync(file).size, sha256: sha256File(file) };
    };

    async function pipeline() {
      const got = serving.snapshot().received;
      state.phase = 'saving the two resources.pri';
      say('');
      say('Both resources.pri have arrived. Saving them where package-msix.mjs looks ...');
      const saved = installIndexes({ store: got.store, test: got.test }, { root: installRoot });
      for (const { file, bytes, sha256, replaced } of saved.installed) {
        say(`Saved ${file}`);
        say(`  ${bytes} bytes, SHA-256 ${sha256}${replaced ? (replaced === sha256 ? ' (the same as the file that was there)' : `; replaced the file that was there, SHA-256 ${replaced}`) : ''}`);
      }
      if (saved.problems.length > 0 || saved.missing.length > 0) throw new Error(`The indexes that arrived cannot be saved: ${JSON.stringify(saved)}`);
      result.saved = saved.installed;
      const indexes = Object.fromEntries(saved.installed.map(({ kind, file }) => [kind, file]));

      state.phase = 'packing both packages with the new resources.pri';
      const packageDir = join(jobDir, 'packages');
      say(`Packing both packages again with them (package-msix.mjs --identity both, the release exe that is there; nothing is built) into ${packageDir} ...`);
      const built = await buildPackages({ scriptsDir, outDir: packageDir, indexes, productName: conf.productName, version, env, say });
      result.built = built;

      state.phase = 'checking the packages';
      say(`Checking the packages (${assetImages().length} images, ${RESOURCE_INDEX} at the root and the one that was saved, identity, version ${version}, x64, family name, unsigned):`);
      let allPass = true;
      for (const kind of KINDS) {
        const gated = gateLines(kind, gatePackage({ kind, file: built[kind], index: got[kind], version }));
        gated.lines.forEach(say);
        allPass &&= gated.ok;
      }
      if (!allPass) throw new Error('A package did not pass the checks above. Nothing was published and nothing was signed.');

      if (dry) seedPublishDir(built, publishDir, say);
      state.phase = 'publishing the packages';
      say(`Publishing the packages in ${publishDir} (a package of the same name that is there is renamed first, never deleted) ...`);
      const published = publishPackages({ built, publishDir, stamp, say });
      result.published = published;
      for (const kind of KINDS) say(`Published ${published[kind].target}\n  ${published[kind].bytes} bytes, SHA-256 ${published[kind].sha256}`);
      state.packages = { version, store: { file: basename(published.store.target), bytes: published.store.bytes, sha256: published.store.sha256 }, test: { file: basename(published.test.target), bytes: published.test.bytes, sha256: published.test.sha256 } };

      state.phase = 'signing a copy of the Store package for the Windows App Certification Kit';
      say('Signing a COPY of the Store package for the Windows App Certification Kit alone ...');
      const wack = signWackCopy({ storePackage: published.store.target, outDir: jobDir, now: now(), env, say, tools: signing });
      result.wack = wack;
      result.unsignedBefore = wack.unsignedSha256.before;
      result.unsignedAfter = wack.unsignedSha256.after;
      say(`The Store package that is published (the one to upload) is unsigned and untouched: SHA-256 ${wack.unsignedSha256.before} before, ${wack.unsignedSha256.after} after.`);
      say(`The WACK copy: ${wack.signedFile}\n  ${wack.signedBytes} bytes, SHA-256 ${wack.signedSha256}\nIts public certificate: ${wack.certificateFile}\n  ${wack.certificate.derBytes} bytes, SHA-256 ${wack.certificate.derSha256}, thumbprint ${wack.certificate.thumbprint}`);

      const testSigned = signTestCopy({ testPackage: published.test.target, outDir: jobDir, env, say, tools: signing });
      result.testSigned = testSigned;
      if (testSigned.skipped) say(`The test package is not signed (${testSigned.skipped}), so the VM will not install it. Its package is ${published.test.target}.`);

      state.wack = {
        ready: true,
        package: serve(wack.signedFile, 'application/octet-stream'),
        certificate: { ...serve(wack.certificateFile, 'application/pkix-cert'), thumbprint: wack.certificate.thumbprint, subject: wack.certificate.subject, notAfter: wack.certificate.notAfter },
      };
      state.testPackage = testSigned.signedFile ? { ...serve(testSigned.signedFile, 'application/octet-stream'), signerThumbprint: testSigned.signerThumbprint, signerSubject: testSigned.signerSubject } : null;
      state.phase = 'ready';
      say('');
      say('The VM can fetch the WACK copy now. Waiting for the report ...');
    }

    function onPipelineError(error) {
      const message = error instanceof Error ? error.message : String(error);
      state.error = message;
      state.phase = 'failed';
      result.pipelineError = message;
      say('');
      say(`The Mac could not finish its part: ${message}`);
      say('The VM learns it from /status within 10 seconds, stops, and says so.');
      waitForTheVm(linger.afterFailure, 'failed');
    }

    function acceptReport(bytes) {
      const file = join(jobDir, 'wack-report.xml');
      writeFileSync(file, bytes);
      result.reportFile = file;
      state.report = { bytes: bytes.length, sha256: sha256Of(bytes) };
      say('');
      say(`The report arrived: ${bytes.length} bytes, SHA-256 ${state.report.sha256}, saved as ${file}`);
      try {
        const report = parseWackReport(bytes);
        result.report = report;
        const lines = formatWackReport(report);
        lines.forEach(say);
        writeFileSync(join(jobDir, 'wack-summary.txt'), `${lines.join('\n')}\n`);
        writeFileSync(join(jobDir, 'wack-summary.json'), `${JSON.stringify(reportSummary(report, { file, sha256: state.report.sha256, bytes: bytes.length }), null, 2)}\n`);
        say(`The summary is saved: ${join(jobDir, 'wack-summary.txt')} and ${join(jobDir, 'wack-summary.json')}`);
      } catch (error) {
        result.reportError = error instanceof Error ? error.message : String(error);
        say(`The report cannot be read: ${result.reportError} It is kept as it came, in ${file}.`);
      }
      if (result.vmFinal !== null) maybeStop();
      else waitForTheVm(state.testPackage === null ? linger.afterReport : linger.afterReportWithTestPackage, result.vmFailure ? 'failed' : 'complete');
    }

    function acceptStatus(bytes) {
      const view = readVmStatus(bytes);
      state.vm = view;
      writeFileSync(join(jobDir, 'vm-status.json'), `${JSON.stringify(view, null, 2)}\n`);
      appendFileSync(join(jobDir, 'vm-status-history.jsonl'), `${JSON.stringify(view)}\n`);
      say(`  VM ${view.state.padEnd(4)} [${view.step}]${view.detail ? ` ${view.detail}` : ''}${view.final ? '  (the last news from the VM)' : ''}`);
      if (view.state === 'FAIL' && result.vmFailure === null) {
        result.vmFailure = view;
        if (!view.final) {
          say(`The VM stopped at the step "${view.step}". It cleans up after itself and then says so; waiting for that.`);
          waitForTheVm(linger.afterFailure, 'failed');
        }
      }
      if (view.final) result.vmFinal = view;
      maybeStop();
    }

    function accept(kind, bytes) {
      if (kind === 'store' || kind === 'test') {
        say(`  the ${kind} resources.pri arrived: ${bytes.length} bytes, SHA-256 ${sha256Of(bytes)}`);
        const got = serving.snapshot().received;
        if (got.store && got.test && !pipelineStarted) {
          pipelineStarted = true;
          // After the answer to this upload has gone, and not in the middle of it.
          setImmediate(() => void pipeline().catch(onPipelineError));
        }
      } else if (kind === 'report') {
        acceptReport(bytes);
      } else if (kind === 'status') {
        acceptStatus(bytes);
      }
    }

    const quiet = (event) => (event.path === STATUS_PATH && event.status === 200) || (event.path === VM_STATUS_PATH && event.status < 300);
    const printer = progressPrinter(say, folders);
    let text = '';
    const scriptFor = (listening) =>
      buildMsixVmScript({
        baseUrl: `http://${listening.host}:${listening.port}`,
        tools: { arm64: tools.arm64.sha256, x64: tools.x64.sha256 },
        files: Object.fromEntries(KINDS.map((kind) => [kind, folders[kind].map(({ path, sha256 }) => ({ path, sha256 }))])),
        unplated: unplatedNames(),
        line: vmLine(listening.host, listening.port),
      });
    // ---- what is said when it is over, and the exit status
    function conclude({ outcome, vmChecks }) {
      const why = { complete: 'the VM finished', failed: 'the job failed', timeout: 'the time ran out', interrupted: 'interrupted' }[outcome.reason] ?? outcome.reason;
      say('');
      say(`The server stopped: ${why}.`);
      say('What was done:');
      say(`  resources.pri: ${result.saved ? result.saved.map(({ kind, file }) => `${kind} -> ${file}`).join('; ') : 'not both received'}`);
      say(`  packages: ${result.published ? KINDS.map((kind) => `${result.published[kind].target} (SHA-256 ${result.published[kind].sha256})`).join('; ') : 'not published'}`);
      say(`  WACK copy: ${result.wack ? `${result.wack.signedFile}, verified with osslsigncode; certificate ${result.wack.certificate.thumbprint}, key deleted: ${result.wack.keyRemoved}` : 'not made'}`);
      say(`  test package signed: ${result.testSigned?.signedFile ? result.testSigned.signedFile : `no (${result.testSigned?.skipped ?? 'not reached'})`}`);
      say(`  report: ${result.reportFile ?? 'did not arrive'}${result.reportError ? ` (cannot be read: ${result.reportError})` : ''}`);
      say(`  VM: ${state.vm ? `last news "${state.vm.state}" at "${state.vm.step}": ${state.vm.detail}` : 'sent nothing'}`);
      const problems = [];
      if (outcome.reason === 'timeout') problems.push('the time ran out');
      if (outcome.reason === 'interrupted') problems.push('it was interrupted');
      if (result.pipelineError) problems.push(`the Mac stopped: ${result.pipelineError}`);
      if (result.vmFailure) problems.push(`the VM stopped at "${result.vmFailure.step}": ${result.vmFailure.detail}`);
      if (result.vmFinal === null && !result.vmFailure && outcome.reason !== 'timeout' && outcome.reason !== 'interrupted') problems.push('the VM never said it had finished (its certificate and package clean-up are not confirmed: look at the VM)');
      if (result.report === null && result.reportError === null) problems.push('no report arrived');
      if (result.reportError) problems.push(`the report cannot be read: ${result.reportError}`);
      if (result.vmFinal?.state === 'FAIL' && /COULD NOT REMOVE/.test(result.vmFinal.detail)) problems.push(`THE VM STILL HAS SOMETHING THAT WAS TO BE TAKEN AWAY: ${result.vmFinal.detail}`);
      let code = 1;
      if (problems.length === 0 && result.report !== null) code = reportPasses(result.report) ? 0 : 2;
      if (problems.length === 0 && result.report !== null && code === 2) problems.push(`the report's overall result is ${result.report.overall ?? 'missing'}${result.report.counts.FAIL > 0 ? ` and ${result.report.counts.FAIL} required test(s) failed` : ''}`);
      say('');
      if (dry) code = concludeDry({ vmChecks, problems, code });
      else say(code === 0 ? 'Done: the report passed, and the VM cleaned up.' : `Not a clean pass (exit status ${code}): ${problems.join('; ')}.`);
      if (!dry && result.published && result.saved) say(`To upload in Partner Center: ${result.published.store.target} (unsigned, SHA-256 ${result.published.store.sha256}). Keep packaging/msix with the repo (git add packaging/msix).`);
      say(`Everything of this run is in ${jobDir}`);
      return code;
    }

    // ---- the checks that end a dry run
    function concludeDry({ vmChecks, problems, code }) {
      const lines = [...vmChecks.passed.map((one) => `  PASS ${one}`), ...vmChecks.failed.map((one) => `  FAIL ${one}`)];
      const check = (ok, what) => lines.push(`  ${ok ? 'PASS' : 'FAIL'} ${what}`);
      check(result.wack?.keyRemoved === true && !existsSync(result.wack.keyDir), `the folder that held the private key is gone (${result.wack?.keyDir ?? 'none was made'})`);
      const leftover = keyMaterialIn(jobDir);
      check(leftover.length === 0, `no key material left in ${jobDir}${leftover.length > 0 ? `: ${leftover.join(', ')}` : ' (every file looked at: no PEM private key, no .pfx, .p12 or .key file)'}`);
      check(result.unsignedBefore !== null && result.unsignedBefore === result.unsignedAfter, `the unsigned Store package has the same SHA-256 before and after the WACK copy was signed: ${result.unsignedBefore} / ${result.unsignedAfter}`);
      check(result.published !== null && result.published.store.renamed.length === 1 && result.published.test.renamed.length === 1 && result.published.store.renamed[0].to.endsWith('.no-pri.msix'), 'the packages already published under those names, which had no resources.pri, were renamed to ...no-pri.msix and kept');
      check(existsSync(join(root, 'packaging')) === packagingBefore, 'packaging/ was not touched');
      check(publishDir.startsWith(jobDir), `nothing was published outside the temporary folder (${publishDir})`);
      check(result.report !== null && result.report.overall === 'PASS' && result.report.counts.WARN === 2, 'the sample report was read: overall PASS with 2 warnings');
      for (const line of lines) say(line);
      const bad = lines.filter((line) => line.startsWith('  FAIL'));
      const wrong = [...problems].filter((problem) => !/^the report's overall result/.test(problem));
      if (bad.length > 0 || wrong.length > 0) {
        say(`Dry run: ${bad.length} check(s) failed${wrong.length > 0 ? `, and ${wrong.join('; ')}` : ''}.`);
        return 1;
      }
      say(`Dry run done: nothing was published in ~/msix-build, nothing was installed in packaging/, and no key material is left. ${keepOutput ? `The folder of the run was kept: ${jobDir}` : 'The temporary folder is removed now.'}`);
      return code;
    }

    let conclusion = 1;
    try {
      serving = await startServer({
        host,
        port,
        routes,
        uploads: VM_UPLOAD_PATHS,
        validate: indexProblem,
        rules: VM_UPLOAD_RULES,
        isComplete: () => false,
        // Only the PC that was given the script may send anything back.
        peerGate: SCRIPT_PATH,
        timeoutMs: options.timeoutMinutes * 60_000,
        signal: controller.signal,
        observe: dry ? () => {} : (event) => (quiet(event) ? undefined : printer(event)),
        onAccepted: accept,
      });
      text = scriptFor(serving);
      routes.set(SCRIPT_PATH, scriptRoute(text));
      routes.set(STATUS_PATH, jsonRoute(statusJson));
      writeFileSync(join(jobDir, 'd.ps1'), text);
      say(`The script for the VM: ${join(jobDir, 'd.ps1')} (${text.length} bytes, ASCII, SHA-256 ${sha256Of(Buffer.from(text, 'utf8'))})`);

      let played = null;
      if (dry) {
        say(`Dry run: serving on http://${serving.host}:${serving.port}. A real run serves on ${DEFAULT_HOST}:${DEFAULT_PORT}, where the VM types: ${vmLine(DEFAULT_HOST, DEFAULT_PORT)}`);
        const sample = Object.fromEntries(KINDS.map((kind) => [kind, sampleIndex(kind)]));
        played = playVm({ where: { host: serving.host, port: serving.port }, script: text, tools, folders, sample, publisher: identityOf('store').publisher }).catch((error) => ({ passed: [], failed: [`the stand-in for the VM broke off: ${error instanceof Error ? error.message : String(error)}`] }));
        played.then(({ failed }) => {
          // A stand-in that gave up leaves no VM to wait for: the run ends here instead of at the end of the time.
          if (failed.length > 0) {
            clearTimeout(lingerTimer);
            serving.stop('failed');
          }
        });
      } else {
        say('');
        say(`Serving on http://${serving.host}:${serving.port} until the VM has sent its report and said it has finished, ${options.timeoutMinutes} minutes pass, or Ctrl-C.`);
        say('In the VM open Windows PowerShell AS ADMINISTRATOR (Start, type PowerShell, right-click Windows PowerShell, Run as administrator) and type this line, exactly');
        say('(or press the up arrow until it is there, and Enter):');
        say('');
        say(`    ${vmLine(serving.host, serving.port)}`);
        say('');
        say('It prints OK lines as it goes, and a FAIL line with the step and the reason at the first thing that goes wrong; this window shows the same.');
        say('If macOS asks whether node may accept incoming network connections, allow it: the VM reaches the Mac through that. Waiting ...');
      }
      const outcome = await serving.finished;
      const vmChecks = played === null ? null : await played;
      conclusion = conclude({ outcome, vmChecks });
    } catch (error) {
      if (serving !== null) {
        serving.stop();
        await serving.finished;
      }
      throw error;
    } finally {
      clearTimeout(lingerTimer);
      process.off('SIGINT', onSignal);
      process.off('SIGTERM', onSignal);
      signal?.removeEventListener('abort', onSignal);
    }
    return conclusion;

  } finally {
    if (!keepOutput) rmSync(parent, { recursive: true, force: true });
  }
}

/**
 * For --dry-run: puts, in `publishDir`, copies of the built packages that have no resources.pri, under the names the real ones are published under, as the
 * packages of 1.3.3 were before the indexes. That makes the publication do the thing it must do on the real run: rename them and keep them.
 */
function seedPublishDir(built, publishDir, say) {
  mkdirSync(publishDir, { recursive: true });
  if (!existsSync('/usr/bin/zip')) {
    say('  (no /usr/bin/zip, so no stand-ins for the packages published earlier were made)');
    return;
  }
  for (const kind of KINDS) {
    const target = join(publishDir, basename(built[kind]));
    copyFileSync(built[kind], target);
    const stripped = spawnSync('/usr/bin/zip', ['-q', '-d', target, RESOURCE_INDEX], { encoding: 'utf8' });
    if (stripped.status !== 0) throw new Failure(`Could not make the stand-in for the earlier ${kind} package: ${stripped.stderr}`);
  }
  say(`  (dry run: ${KINDS.length} stand-ins for the packages published before the indexes, without a resources.pri, put in ${publishDir})`);
}

const entry = (() => {
  try {
    return process.argv[1] ? realpathSync(process.argv[1]) : null;
  } catch {
    return null;
  }
})();
const self = (() => {
  try {
    return realpathSync(import.meta.filename);
  } catch {
    return null;
  }
})();
if (self !== null && self === entry) {
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
