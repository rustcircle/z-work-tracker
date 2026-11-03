// The parts of an MSIX package for the Microsoft Store that come from values, not from files: the version the Store
// takes, the identity Partner Center issues, AppxManifest.xml, where the licenses go, and which version an exe carries.
// All pure, so a test can check them on any OS without makemsix. scripts/package-msix.mjs does the files.
import { posix, resolve } from 'node:path';

/** The exe the package starts. package-msix.mjs puts it beside AppxManifest.xml. */
export const EXECUTABLE = 'zWorkTracker.exe';
/** The images the manifest names, as Assets\<name>.png, and the size in pixels each is cut to from the app icon. */
export const ASSETS = { StoreLogo: 50, Square44x44Logo: 44, Square150x150Logo: 150 };

const MAX_PART = 65535;
const PART = '(0|[1-9]\\d{0,4})';
const VERSION = new RegExp(`^${PART}\\.${PART}\\.${PART}(?:\\.0)?$`);
// Package/Identity/Name as Partner Center issues it: 3 to 50 letters, digits, dots and hyphens.
const NAME = /^[-.A-Za-z0-9]{3,50}$/;
// A control character other than tab, line feed and carriage return, or U+FFFE or U+FFFF. XML does not allow them.
const NOT_XML = /[^\P{Cc}\t\n\r]|[\uFFFE\uFFFF]/u;
const ESCAPED = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' };
const IDENTITY = [
  ['name', 'ZWT_STORE_IDENTITY_NAME', 'Package/Identity/Name'],
  ['publisher', 'ZWT_STORE_PUBLISHER', 'Package/Identity/Publisher'],
  ['publisherDisplayName', 'ZWT_STORE_PUBLISHER_DISPLAY_NAME', 'Package/Properties/PublisherDisplayName'],
];

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
 * The three values Partner Center issues for the app, under Product management > Product identity. They are the Store's
 * to give, so none has a default: any that is missing or blank is named in the error, together with where to find it.
 * Spaces around a value, left by copying it, are removed.
 */
export function readIdentity(env) {
  const read = IDENTITY.map(([key, variable, field]) => ({ key, variable, field, value: (env[variable] ?? '').trim() }));
  const missing = read.filter((item) => item.value === '');
  if (missing.length > 0) {
    const names = missing.map((item) => `${item.variable} (${item.field})`).join(', ');
    throw new Error(`Missing ${names}. Partner Center issues these, so they have no defaults: copy them from your app's Product management > Product identity page.`);
  }
  const identity = Object.fromEntries(read.map((item) => [item.key, item.value]));
  if (!identity.publisher.startsWith('CN=')) {
    throw new Error(`ZWT_STORE_PUBLISHER must be Package/Identity/Publisher from Product identity, which starts with CN= (got ${JSON.stringify(identity.publisher)}).`);
  }
  if (!NAME.test(identity.name)) {
    throw new Error(`ZWT_STORE_IDENTITY_NAME must be Package/Identity/Name from Product identity: 3 to 50 letters, digits, dots or hyphens (got ${JSON.stringify(identity.name)}).`);
  }
  return identity;
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
