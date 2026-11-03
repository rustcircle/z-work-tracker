// The parts of the MSIX packages for the Microsoft Store that come from values, not from files: the version the Store
// takes, the two identities one run packs (the Store's and a test one), their package family names and file names,
// AppxManifest.xml, where the licenses go, and which version an exe carries.
// All pure, so a test can check them on any OS without makemsix. scripts/package-msix.mjs does the files.
import { createHash } from 'node:crypto';
import { posix, resolve } from 'node:path';

/** The exe the package starts. package-msix.mjs puts it beside AppxManifest.xml. */
export const EXECUTABLE = 'zWorkTracker.exe';
/** The images the manifest names, as Assets\<name>.png, and the size in pixels each is cut to from the app icon. */
export const ASSETS = { StoreLogo: 50, Square44x44Logo: 44, Square150x150Logo: 150 };

/**
 * The two packages one run makes from the same build, in the order they are made. Neither is signed here.
 * `store` carries the identity Partner Center issued for the app (Product management > Product identity). Those values are
 * public and final, so they are kept here and need no setting; the Store signs what it publishes.
 * `test` carries an identity of our own, for trying the package on a PC: its Publisher is the subject of the throwaway
 * certificate it is signed with by hand before it is installed. Its package family name differs from the Store's, so it
 * keeps its data in a folder of its own.
 * `suffix` ends the file name, after the version and the architecture.
 */
export const PACKAGES = Object.freeze({
  store: Object.freeze({
    suffix: 'store',
    identity: Object.freeze({
      name: 'PedroMiguelRodriguesJorge.zWorkTracker',
      publisher: 'CN=1DEF8D7B-1D68-4604-8047-048DC92CF3A9',
      publisherDisplayName: 'Pedro Miguel Rodrigues Jorge',
    }),
  }),
  test: Object.freeze({
    suffix: 'test-unsigned',
    identity: Object.freeze({
      name: 'rustcircle.zWorkTracker.Test',
      publisher: 'CN=zWorkTracker Test Signing',
      publisherDisplayName: 'zWorkTracker (test)',
    }),
  }),
});

const MAX_PART = 65535;
const PART = '(0|[1-9]\\d{0,4})';
const VERSION = new RegExp(`^${PART}\\.${PART}\\.${PART}(?:\\.0)?$`);
// Package/Identity/Name as Partner Center issues it: 3 to 50 letters, digits, dots and hyphens.
const NAME = /^[-.A-Za-z0-9]{3,50}$/;
// A control character other than tab, line feed and carriage return, or U+FFFE or U+FFFF. XML does not allow them.
const NOT_XML = /[^\P{Cc}\t\n\r]|[\uFFFE\uFFFF]/u;
const ESCAPED = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' };
// What --identity may say, and the packages each choice makes.
const CHOICES = Object.freeze({ store: ['store'], test: ['test'], both: ['store', 'test'] });
// The variables that named the Store identity while Partner Center had not issued it. They are no longer read.
const RETIRED = ['ZWT_STORE_IDENTITY_NAME', 'ZWT_STORE_PUBLISHER', 'ZWT_STORE_PUBLISHER_DISPLAY_NAME'];
// Windows spells a publisher in a package family name with these 32 characters: the digits and the lowercase letters,
// less i, l, o and u.
const ID_ALPHABET = '0123456789abcdefghjkmnpqrstvwxyz';

/**
 * The four-part version a package carries: 'x.y.z' becomes 'x.y.z.0'. A fourth part is taken only as 0, so what this
 * returns can be passed in again. Microsoft's rules for Windows 10 and 11 packages: the Store owns the fourth part and
 * wants 0 there, every part is a whole number from 0 to 65535, and the first part cannot be 0. A version that breaks
 * any of them throws, rather than becoming a package the Store would turn away.
 * https://learn.microsoft.com/en-us/windows/apps/publish/publish-your-app/msix/app-package-requirements
 */
export function msixVersion(version) {
  const shown = typeof version === 'string' ? JSON.stringify(version) : String(version);
  const match = typeof version === 'string' ? VERSION.exec(version) : null;
  if (!match) {
    throw new Error(`${shown} is not a version the Store takes: use x.y.z, whole numbers from 0 to ${MAX_PART} (a fourth part may only be 0).`);
  }
  const parts = match.slice(1, 4).map(Number);
  if (parts.some((part) => part > MAX_PART)) throw new Error(`${shown} is too big: each part of a package version is at most ${MAX_PART}.`);
  if (parts[0] === 0) throw new Error(`${shown} starts with 0, which the Microsoft Store does not accept as the first part of a package version.`);
  return `${parts.join('.')}.0`;
}

/**
 * The command line of package-msix.mjs: `--build`, which builds the Windows app first, and `--identity store|test|both`
 * (or `--identity=test`), which says which packages to make. With no `--identity` it is `store`, the Store identity;
 * `--identity both` makes the Store package and the test package from the same build. Returns `{ build, kinds }`, `kinds` being the packages to make in the order
 * they are made. Anything else throws, so a misspelt option is not taken for a default.
 */
export function parseArguments(argv) {
  let build = false;
  let choice = null;
  const unknown = [];
  for (let at = 0; at < argv.length; at++) {
    const arg = argv[at];
    if (arg === '--build') {
      build = true;
    } else if (arg === '--identity' || arg.startsWith('--identity=')) {
      const value = arg === '--identity' ? argv[++at] : arg.slice('--identity='.length);
      if (choice !== null) throw new Error('--identity was given more than once: say store, test or both once.');
      if (typeof value !== 'string' || !Object.hasOwn(CHOICES, value)) {
        throw new Error(`--identity must be store, test or both (got ${value === undefined ? 'nothing' : JSON.stringify(value)}).`);
      }
      choice = value;
    } else {
      unknown.push(arg);
    }
  }
  if (unknown.length > 0) {
    throw new Error(`Unknown argument: ${unknown.join(' ')}. The options are --build, which builds the Windows app first, and --identity store|test|both, which says which packages to make (the default is store).`);
  }
  return { build, kinds: [...CHOICES[choice ?? 'store']] };
}

/**
 * The variables of earlier versions that are set in `env`. They named the Store identity before Partner Center issued it and
 * are not read now: the identities are in PACKAGES. The script says so when one is set, so a value left in a shell, from making
 * a test package say, is not taken for an override of the Store identity.
 */
export function retiredVariables(env) {
  return RETIRED.filter((variable) => (env[variable] ?? '').trim() !== '');
}

/**
 * Checks an identity against what Partner Center issues: a name of 3 to 50 letters, digits, dots and hyphens, and a publisher
 * that is a distinguished name starting with CN=. The display name is free text, so it is checked only by `buildManifest`.
 * Returns the identity, or throws.
 */
export function checkIdentity(identity) {
  const { name, publisher } = identity;
  if (typeof publisher !== 'string' || !publisher.startsWith('CN=')) {
    throw new Error(`Package/Identity/Publisher must start with CN= (got ${JSON.stringify(publisher)}).`);
  }
  if (typeof name !== 'string' || !NAME.test(name)) {
    throw new Error(`Package/Identity/Name must be 3 to 50 letters, digits, dots or hyphens (got ${JSON.stringify(name)}).`);
  }
  return identity;
}

/** The identity of the `store` or `test` package, checked. Anything else throws. */
export function identityOf(kind) {
  if (typeof kind !== 'string' || !Object.hasOwn(PACKAGES, kind)) {
    throw new Error(`Unknown package ${JSON.stringify(kind)}: the packages are ${Object.keys(PACKAGES).join(' and ')}.`);
  }
  return checkIdentity({ ...PACKAGES[kind].identity });
}

/** The file name of a package: `zWorkTracker_1.3.2.0_x64_store.msix`. The version may be given with or without its fourth part. */
export function msixFileName(productName, version, kind) {
  identityOf(kind);
  return `${productName}_${msixVersion(version)}_x64_${PACKAGES[kind].suffix}.msix`;
}

/**
 * The 13 characters that stand for a publisher in a package family name. `hash` is the first 8 bytes of the SHA-256 of the
 * Publisher string written as UTF-16LE: those 64 bits and one 0 bit after them make 65, read as 13 groups of 5 bits, the most
 * significant group first, each group a character of `0123456789abcdefghjkmnpqrstvwxyz`.
 */
export function encodePublisherHash(hash) {
  if (hash.length !== 8) throw new Error(`A publisher hash is 8 bytes, not ${hash.length}.`);
  let bits = 0n;
  for (const byte of hash) bits = (bits << 8n) | BigInt(byte);
  bits <<= 1n;
  let id = '';
  for (let group = 12; group >= 0; group--) id += ID_ALPHABET[Number((bits >> BigInt(5 * group)) & 31n)];
  return id;
}

/** The 13 characters that stand for `publisher`, a string such as `CN=1DEF8D7B-1D68-4604-8047-048DC92CF3A9`, in a package family name. */
export function publisherId(publisher) {
  if (typeof publisher !== 'string' || publisher === '') throw new Error('A publisher id needs the Publisher string of the manifest.');
  return encodePublisherHash(createHash('sha256').update(publisher, 'utf16le').digest().subarray(0, 8));
}

/**
 * The package family name Windows gives a package: its Identity Name, an underscore and the id of its Publisher. It names the
 * folder the package keeps its data in, under %LOCALAPPDATA%\Packages. Pass the Name and Publisher read back from a built package's
 * manifest to learn what Windows will call it.
 */
export function packageFamilyName(name, publisher) {
  if (typeof name !== 'string' || name === '') throw new Error('A package family name needs the Identity Name of the manifest.');
  return `${name}_${publisherId(publisher)}`;
}

/**
 * Where each file named in bundle.resources goes in the package: [{ from, to }], with `from` an absolute path (the keys are
 * relative to src-tauri) and `to` a file name inside the package, with forward slashes. The licenses ship from there, so a
 * map that is missing or empty throws, and so does a destination that is not a file name inside the package.
 */
export function resourceCopies(resources, tauriDir) {
  if (resources === null || typeof resources !== 'object' || Array.isArray(resources) || Object.keys(resources).length === 0) {
    throw new Error('bundle.resources in src-tauri/tauri.conf.json must map each file to where it goes in the app, as it does today. The licenses ship from there.');
  }
  return Object.entries(resources).map(([from, to]) => {
    const inside = typeof to === 'string' && !to.includes('\\') ? posix.normalize(to) : '';
    if (inside === '' || inside === '.' || inside === '..' || inside.startsWith('../') || inside.endsWith('/') || posix.isAbsolute(inside)) {
      throw new Error(`bundle.resources puts ${from} at ${JSON.stringify(to)}, which is not a file name inside the app.`);
    }
    return { from: resolve(tauriDir, from), to: inside };
  });
}

/**
 * The ProductVersion in the version resource of a Windows exe, which the Tauri build fills in from tauri.conf.json, or null
 * if it can't be read. The resource is UTF-16, and the value follows its key: that key ends on a 4-byte boundary, so no
 * padding sits between them. `exe` is the file's bytes.
 */
export function embeddedVersion(exe) {
  const key = Buffer.from('ProductVersion\0', 'utf16le');
  const at = exe.indexOf(key);
  if (at < 0) return null;
  const start = at + key.length;
  let end = start;
  while (end + 1 < exe.length && exe.readUInt16LE(end) !== 0) end += 2;
  // An empty value, or one that runs to the end of the file without its terminator, is not a version that was read.
  return end === start || end + 1 >= exe.length ? null : exe.toString('utf16le', start, end);
}

function escapeXml(text) {
  return text.replace(/[&<>"']/g, (char) => ESCAPED[char]);
}

/**
 * AppxManifest.xml for the app as a full-trust Windows desktop program, x64, with a "Start with Windows" entry that is off
 * until the user turns it on in Windows. Every value is escaped, so none can add markup. The version is passed through
 * msixVersion, so it is the one the Store takes.
 */
export function buildManifest({ name, publisher, publisherDisplayName, displayName, description, version }) {
  for (const [field, value] of Object.entries({ name, publisher, publisherDisplayName, displayName, description })) {
    if (typeof value !== 'string' || value.trim() === '') throw new Error(`The manifest needs a ${field}.`);
    if (NOT_XML.test(value)) throw new Error(`The manifest's ${field} has a character that XML does not allow.`);
  }
  const [id, publisherName, publisherShown, shown, about] = [name, publisher, publisherDisplayName, displayName, description].map(escapeXml);
  const logo = (image) => `Assets\\${image}.png`;
  return `<?xml version="1.0" encoding="utf-8"?>
<Package
  xmlns="http://schemas.microsoft.com/appx/manifest/foundation/windows10"
  xmlns:uap="http://schemas.microsoft.com/appx/manifest/uap/windows10"
  xmlns:rescap="http://schemas.microsoft.com/appx/manifest/foundation/windows10/restrictedcapabilities"
  xmlns:desktop="http://schemas.microsoft.com/appx/manifest/desktop/windows10"
  IgnorableNamespaces="uap rescap desktop">
  <Identity Name="${id}" Publisher="${publisherName}" Version="${msixVersion(version)}" ProcessorArchitecture="x64" />
  <Properties>
    <DisplayName>${shown}</DisplayName>
    <PublisherDisplayName>${publisherShown}</PublisherDisplayName>
    <Logo>${logo('StoreLogo')}</Logo>
  </Properties>
  <Dependencies>
    <TargetDeviceFamily Name="Windows.Desktop" MinVersion="10.0.19041.0" MaxVersionTested="10.0.26100.0" />
  </Dependencies>
  <Resources>
    <Resource Language="en-us" />
  </Resources>
  <Applications>
    <Application Id="zWorkTracker" Executable="${EXECUTABLE}" EntryPoint="Windows.FullTrustApplication">
      <uap:VisualElements DisplayName="${shown}" Description="${about}" BackgroundColor="transparent" Square150x150Logo="${logo('Square150x150Logo')}" Square44x44Logo="${logo('Square44x44Logo')}" />
      <Extensions>
        <desktop:Extension Category="windows.startupTask" Executable="${EXECUTABLE}" EntryPoint="Windows.FullTrustApplication">
          <desktop:StartupTask TaskId="zWorkTrackerStartup" Enabled="false" DisplayName="${shown}" />
        </desktop:Extension>
      </Extensions>
    </Application>
  </Applications>
  <Capabilities>
    <rescap:Capability Name="runFullTrust" />
  </Capabilities>
</Package>
`;
}

/** AppxManifest.xml of the `store` or `test` package: `buildManifest` with the identity of that package. */
export function manifestFor(kind, { displayName, description, version }) {
  return buildManifest({ ...identityOf(kind), displayName, description, version });
}
