// The parts of the MSIX packages for the Microsoft Store that come from values, not from files: the version the Store
// takes, the two identities one run packs (the Store's and a test one), their package family names and file names,
// AppxManifest.xml, the list of images in Assets and how to read a PNG header, where the licenses go, which version
// an exe carries, and where the prebuilt resource index (resources.pri) of a package is looked for and what it must be.
// All pure, so a test can check them on any OS without makemsix: even the lookup of the resource index is handed the function that reads
// a file. scripts/package-msix.mjs does the files, and scripts/msix-stage.mjs the staging that it shares with scripts/make-pri.mjs.
import { createHash } from 'node:crypto';
import { join, posix, resolve } from 'node:path';

/** The exe the package starts. package-msix.mjs puts it beside AppxManifest.xml. */
export const EXECUTABLE = 'zWorkTracker.exe';
/**
 * The file at the root of a package through which Windows finds the images whose names carry a qualifier (`.scale-200`,
 * `.targetsize-24`, `_altform-unplated`). makepri, a Windows program, makes it: so it is made there, once for each package
 * (`pnpm msix:pri`, scripts/make-pri.mjs, has a Windows VM do it), and kept in the repo at `packaging/msix/<package>/resources.pri`
 * or named by ZWT_MSIX_PRI_<PACKAGE>.
 */
export const RESOURCE_INDEX = 'resources.pri';
/**
 * The images the manifest names, as Assets\<name>.png, and the size in pixels each is cut to from the app icon. These are
 * the base sizes: `assetImages` adds the files Windows picks from at each display scale and the taskbar icons.
 */
export const ASSETS = Object.freeze({ StoreLogo: 50, Square44x44Logo: 44, Square150x150Logo: 150 });
/** The manifest entry that is the app's icon in the taskbar, Start and the app list. */
const APP_LIST = 'Square44x44Logo';
/**
 * The sides in pixels at which Windows asks for the app list icon: the taskbar, Start, the title bar and the menus draw it at
 * these, from 16 at 100% scale to 256 for a Start pin at 400%.
 * https://learn.microsoft.com/en-us/windows/apps/design/style/iconography/app-icon-construction
 */
export const TARGET_SIZES = Object.freeze([16, 20, 24, 30, 32, 36, 40, 48, 60, 64, 72, 80, 96, 256]);
/** The display scales, in percent, at which each logo is cut. Windows picks the nearest one for the scales in between. */
export const SCALES = Object.freeze([100, 125, 150, 200, 400]);
/**
 * The three forms of each target-size icon, as the end of the name before `.png`: the plain one, the unplated one for the dark
 * shell theme and the light-unplated one for the light theme. Microsoft asks for all three. Without the unplated forms the
 * taskbar and Start put a backplate behind the icon, as the 1.3.2 package, which had only the plain Square44x44Logo.png, did
 * on Windows 11 even though the logo is transparent.
 */
export const TARGET_FORMS = Object.freeze(['', '_altform-unplated', '_altform-lightunplated']);

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

/** The file name of a package: `zWorkTracker_1.3.3.0_x64_store.msix`. The version may be given with or without its fourth part. */
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
 * The side in pixels of a logo whose base size is `base`, at a display scale of `scale` percent. A half rounds up, as in
 * Microsoft's table: Square150x150Logo is 188 px at 125%, and StoreLogo 63 px.
 */
export function scaledSize(base, scale) {
  return Math.round((base * scale) / 100);
}

/**
 * Every image the packages carry in Assets, as `{ name, size }`: `name` is the path inside the package, with forward slashes,
 * and `size` the side in pixels it is cut to from the app icon. Both packages get all of them:
 * - the plain `<logo>.png` that the manifest names, for each of the logos in ASSETS, at its base size;
 * - `<logo>.scale-<percent>.png` for each logo at each of SCALES, which Windows picks from by display scale;
 * - `Square44x44Logo.targetsize-<side>.png` for each of TARGET_SIZES, in each of TARGET_FORMS, which the taskbar and Start use.
 * Windows finds the qualified names (`.scale-`, `.targetsize-`, `_altform-`) through the package's resource index, resources.pri,
 * and falls back to the plain file the manifest names; that is why the plain files stay.
 */
export function assetImages() {
  const images = Object.entries(ASSETS).map(([logo, size]) => ({ name: `Assets/${logo}.png`, size }));
  for (const [logo, base] of Object.entries(ASSETS)) {
    for (const scale of SCALES) images.push({ name: `Assets/${logo}.scale-${scale}.png`, size: scaledSize(base, scale) });
  }
  for (const form of TARGET_FORMS) {
    for (const size of TARGET_SIZES) images.push({ name: `Assets/${APP_LIST}.targetsize-${size}${form}.png`, size });
  }
  return images;
}

/** The images of `assetImages` that `entries`, the names of the files inside a package, lack. None means the package carries them all. */
export function lackingAssets(entries) {
  const have = new Set(entries);
  return assetImages()
    .map(({ name }) => name)
    .filter((name) => !have.has(name));
}

// How a PRI file starts. Microsoft does not document the format, so this is read off files: the two resources.pri of Microsoft's own test
// packages (github.com/microsoft/msix-packaging: src/test/testData/pack/input and tools/pipelines-tasks/test/assets/PrebuiltBinaries),
// made by makepri for Windows 10, and the index of Windows Terminal dumped in github.com/awakecoding/pri-format. All three start with the
// eight bytes of mrm_pri2, and end with them. mrm_pri3 and mrm_prif turned up in none of them nor in Microsoft's documentation, so they
// are not taken: if a makepri is found to write another, add it here.
const PRI_MAGICS = Object.freeze(['mrm_pri2']);

function reason(error) {
  return error instanceof Error ? error.message : String(error);
}

/** The first bytes of a file as text for a message: printable ASCII as it is, any other byte as \xNN. */
function printable(bytes) {
  return bytes.toString('latin1').replace(/[^ -~]/g, (char) => `\\x${char.charCodeAt(0).toString(16).padStart(2, '0')}`);
}

/** The variable that names the resource index of the `store` or `test` package, ahead of the usual place: ZWT_MSIX_PRI_STORE or ZWT_MSIX_PRI_TEST. */
export function resourceIndexVariable(kind) {
  identityOf(kind);
  return `ZWT_MSIX_PRI_${kind.toUpperCase()}`;
}

/**
 * Checks `bytes`, a prebuilt resources.pri, as the resource index of the `store` or `test` package. It returns them, or throws what
 * is wrong, as a clause that ends the sentence "<file> cannot be the resource index of the <package> package: ...". It must:
 * - not be empty, and start like a PRI file that makepri made for Windows 10 (PRI_MAGICS);
 * - name the Identity Name of this package, and not the one of the other. makepri writes the name of the resource map, which is the
 *   Identity Name of the AppxManifest.xml it is given, into the index, as UTF-16LE: in the three files above both as ms-appx://<name>/ and
 *   on its own. Windows reads an index as the index of the package whose name it holds, so one made for the test package, put in the Store
 *   package, would pass for it here and not work there.
 */
export function checkResourceIndex(kind, bytes) {
  const { name } = identityOf(kind);
  if (bytes.length === 0) throw new Error('it is empty.');
  if (!PRI_MAGICS.some((magic) => bytes.subarray(0, magic.length).equals(Buffer.from(magic, 'latin1')))) {
    throw new Error(`it is not a PRI file: it starts with "${printable(bytes.subarray(0, 8))}", and one that makepri made for Windows 10 starts with ${PRI_MAGICS.join(' or ')}.`);
  }
  const names = (identity) => bytes.includes(Buffer.from(identity, 'utf16le'));
  const other = Object.keys(PACKAGES).find((one) => one !== kind && names(PACKAGES[one].identity.name));
  if (other !== undefined) {
    throw new Error(`it names the identity of the ${other} package, ${PACKAGES[other].identity.name}, and the ${kind} package's is ${name}. Windows uses an index only for the package whose name it holds.`);
  }
  if (!names(name)) {
    throw new Error(`it does not name the identity of the ${kind} package, ${name}. makepri writes into the index the Identity Name of the AppxManifest.xml it is given, so this one was made from another manifest.`);
  }
  return bytes;
}

/**
 * How makepri writes the path of an image into a resource index: with the backslash Windows uses, and as 8-bit text. The index keeps the
 * path of every image file, to open the one Windows picks for a size or a scale. A path that is plain ASCII is written as it is, one byte to a
 * letter, and only names (the Identity Name, ms-appx://<name>/) are UTF-16LE. Read off the same two files of Microsoft's as PRI_MAGICS: each
 * holds Assets\Square44x44Logo.targetsize-24_altform-unplated.png, and the path of every other file of its Assets folder, in that form.
 */
export function indexPathOf(name) {
  return name.replaceAll('/', '\\');
}

/**
 * Whether `bytes`, a resources.pri, holds the path of the image `name` (such as `Assets/StoreLogo.png`): as `indexPathOf` writes it, or in UTF-16LE,
 * which is how makepri would write a path with a character outside ASCII. The paths of the images are all ASCII, so the second form is the
 * unlikely one; it is accepted so that the check cannot turn away an index only because of how its strings are stored.
 */
export function indexHoldsImage(bytes, name) {
  const path = indexPathOf(name);
  return bytes.includes(Buffer.from(path, 'latin1')) || bytes.includes(Buffer.from(path, 'utf16le'));
}

/** The images of `assetImages` whose paths `bytes`, a resources.pri, does not hold. None means the index lists all of them. */
export function imagesLackingInIndex(bytes) {
  return assetImages()
    .map(({ name }) => name)
    .filter((name) => !indexHoldsImage(bytes, name));
}

/**
 * Checks that `bytes`, a resources.pri, lists every image of `assetImages`, and returns them, or throws what is wrong as a clause that ends the
 * sentence "<file> cannot be the resource index of the <package> package: ...". An index lists the images that were in the folder it was made
 * from, so one made before the set of images changed, or from a folder that lacked some, would still pass `checkResourceIndex` and leave
 * Windows without the images it lacks: the unplated ones, which are what takes the plate away.
 */
export function checkIndexImages(bytes) {
  const lacking = imagesLackingInIndex(bytes);
  if (lacking.length > 0) {
    const shown = lacking.length > 3 ? `${lacking.slice(0, 3).join(', ')} and ${lacking.length - 3} more` : lacking.join(', ');
    throw new Error(
      `it does not list ${lacking.length} of the ${assetImages().length} images of a package (${shown}). An index lists the images that were there when it was made, so ` +
        'this one was made for another set of images, and Windows would not find those through it. Make it again with pnpm msix:pri.',
    );
  }
  return bytes;
}

/**
 * The prebuilt resource index of the `store` or `test` package, found and checked: `{ file, bytes, variable }`, or null if there is none.
 * It is the file the variable of `resourceIndexVariable` names in `env`, or, if that is not set or blank, `packaging/msix/<package>/resources.pri`
 * under `root`, the repo. `read` is handed a path and returns the file's bytes, or null if there is no such file. Nothing at the usual place
 * is no index and no error; a variable that names a file that is not there is an error, since it cannot mean "no index". `variable` is the
 * one that named the file, or null if it was the usual place. A file that `checkResourceIndex` refuses, or that `checkIndexImages` does for
 * lacking images of the package, throws, saying which.
 */
export function resourceIndexFor(kind, { env, root, read }) {
  const variable = resourceIndexVariable(kind);
  const chosen = (env[variable] ?? '').trim();
  const file = chosen === '' ? join(root, 'packaging', 'msix', kind, RESOURCE_INDEX) : resolve(chosen);
  let bytes;
  try {
    bytes = read(file);
  } catch (error) {
    throw new Error(`Could not read ${file}: ${reason(error)}`);
  }
  if (bytes === null) {
    if (chosen !== '') throw new Error(`${variable} names ${file}, which is not there.`);
    return null;
  }
  try {
    checkResourceIndex(kind, bytes);
    checkIndexImages(bytes);
  } catch (error) {
    throw new Error(`${file} cannot be the resource index of the ${kind} package: ${reason(error)}`);
  }
  return { file, bytes, variable: chosen === '' ? null : variable };
}

/**
 * What the header of a PNG says, read from the file's `bytes`: `{ width, height, alpha }`, where `alpha` is true if the image can be
 * transparent, that is if it has an alpha channel or a tRNS chunk. It is null if `bytes` do not start like a PNG. No pixel is read.
 * The cut logos are checked with it, since an image with no transparency is drawn as a solid square.
 */
export function pngInfo(bytes) {
  const SIGNATURE = Buffer.from('89504e470d0a1a0a', 'hex');
  // The signature, then the header chunk: its length, its name, 13 bytes of data (width, height, bit depth, colour type, ...) and a checksum.
  if (bytes.length < 33 || !bytes.subarray(0, 8).equals(SIGNATURE) || bytes.toString('latin1', 12, 16) !== 'IHDR') return null;
  const colourType = bytes[25];
  // Colour types 4 (grey and alpha) and 6 (RGBA) carry alpha. The others can declare a transparent colour in a tRNS chunk before the pixels.
  let alpha = colourType === 4 || colourType === 6;
  for (let at = 33; !alpha && at + 8 <= bytes.length; ) {
    const type = bytes.toString('latin1', at + 4, at + 8);
    if (type === 'tRNS') alpha = true;
    if (type === 'IDAT' || type === 'IEND') break;
    at += 12 + bytes.readUInt32BE(at);
  }
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20), alpha };
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
