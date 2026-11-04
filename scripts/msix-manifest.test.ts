// @vitest-environment jsdom
// jsdom for DOMParser: the manifest is read back as XML, so what is checked is what a reader of the package would see.
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  ASSETS,
  PACKAGES,
  RESOURCE_INDEX,
  assetImages,
  buildManifest,
  checkIdentity,
  checkResourceIndex,
  embeddedVersion,
  encodePublisherHash,
  identityOf,
  lackingAssets,
  manifestFor,
  msixFileName,
  msixVersion,
  packageFamilyName,
  parseArguments,
  pngInfo,
  publisherId,
  resourceCopies,
  resourceIndexFor,
  resourceIndexVariable,
  retiredVariables,
  scaledSize,
} from './msix-manifest.mjs';

const NS = {
  foundation: 'http://schemas.microsoft.com/appx/manifest/foundation/windows10',
  uap: 'http://schemas.microsoft.com/appx/manifest/uap/windows10',
  rescap: 'http://schemas.microsoft.com/appx/manifest/foundation/windows10/restrictedcapabilities',
  desktop: 'http://schemas.microsoft.com/appx/manifest/desktop/windows10',
};

// The two identities as they must be, written out here and not read from the module, so that a change to either one fails a test.
/** What Partner Center issued for the app, under Product management > Product identity. The Store signs the package. */
const STORE = {
  name: 'PedroMiguelRodriguesJorge.zWorkTracker',
  publisher: 'CN=1DEF8D7B-1D68-4604-8047-048DC92CF3A9',
  publisherDisplayName: 'Pedro Miguel Rodrigues Jorge',
  family: 'PedroMiguelRodriguesJorge.zWorkTracker_54k2cbaqgvhqp',
  file: 'zWorkTracker_1.3.3.0_x64_store.msix',
};
/** The identity of the package made for trying the app on a PC. Its Publisher is the subject of the certificate it is signed with. */
const TEST = {
  name: 'rustcircle.zWorkTracker.Test',
  publisher: 'CN=zWorkTracker Test Signing',
  publisherDisplayName: 'zWorkTracker (test)',
  family: 'rustcircle.zWorkTracker.Test_ym7m1j5c19s9r',
  file: 'zWorkTracker_1.3.3.0_x64_test-unsigned.msix',
};

/** A made-up identity, for the tests of the manifest as such. */
const fields = {
  name: 'Placeholder.zWorkTracker',
  publisher: 'CN=00000000-0000-0000-0000-000000000000',
  publisherDisplayName: 'Pedro Miguel Rodrigues Jorge',
  displayName: 'zWorkTracker',
  description: 'Labor hours tracker',
  version: '1.3.0',
};

/** What the packaging script passes besides the identity. */
const app = { displayName: 'zWorkTracker', description: 'Labor hours tracker', version: '1.3.3' };

/** What a call said when it threw. */
function messageOf(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error('expected the call to throw');
}

/** The manifest read back by an XML parser, which fails the test if it is not well-formed. */
function parse(xml: string): Document {
  const doc = new DOMParser().parseFromString(xml, 'application/xml');
  expect(doc.getElementsByTagName('parsererror')).toHaveLength(0);
  return doc;
}

/** The one element with this namespace and name. */
function only(doc: Document, ns: string, name: string): Element {
  const found = doc.getElementsByTagNameNS(ns, name);
  expect(found, name).toHaveLength(1);
  const element = found.item(0);
  if (!element) throw new Error(`no <${name}>`);
  return element;
}

function attrs(element: Element): Record<string, string> {
  return Object.fromEntries(Array.from(element.attributes, (a) => [a.name, a.value]));
}

describe('the package version', () => {
  it('adds the fourth part, which the Store keeps for itself', () => {
    expect(msixVersion('1.3.0')).toBe('1.3.0.0');
    expect(msixVersion('10.20.30')).toBe('10.20.30.0');
    expect(msixVersion('1.0.0')).toBe('1.0.0.0');
  });

  it('takes its own result back, since a fourth part of 0 is what the Store wants', () => {
    expect(msixVersion('1.3.0.0')).toBe('1.3.0.0');
  });

  it('allows 65535 in a part and no more', () => {
    expect(msixVersion('65535.65535.65535')).toBe('65535.65535.65535.0');
    for (const version of ['65536.0.0', '1.65536.0', '1.0.65536', '99999.0.0']) {
      expect(messageOf(() => msixVersion(version)), version).toContain('at most 65535');
    }
  });

  it('refuses anything that is not three whole numbers', () => {
    const bad = ['1.3', '1', '', '1.3.0.1', '1.3.0.0.0', '1.3.0-beta.1', '1.3.0+5', 'v1.3.0', '1.3.x', ' 1.3.0', '1.3.0 ', '1.03.0', '1.-3.0', '1..0', '1.3.0.', '1.3.0.00', '100000.0.0'];
    for (const version of bad) expect(messageOf(() => msixVersion(version)), version).toContain('is not a version the Store takes');
    for (const version of [undefined, null, 1.3, {}, ['1', '3', '0']]) {
      expect(messageOf(() => msixVersion(version))).toContain('is not a version the Store takes');
    }
  });

  it('refuses a first part of 0, which the Store does not accept, instead of passing it on', () => {
    for (const version of ['0.2.0', '0.0.1', '0.65535.0', '0.2.0.0']) {
      expect(messageOf(() => msixVersion(version)), version).toContain('starts with 0');
    }
    expect(msixVersion('1.0.0')).toBe('1.0.0.0');
  });
});

describe('the two packages one run makes', () => {
  it('are the Store package and then the test package, and no others', () => {
    expect(Object.keys(PACKAGES)).toEqual(['store', 'test']);
  });

  it('give the Store package the identity Partner Center issued, with no setting needed', () => {
    expect(identityOf('store')).toEqual({ name: STORE.name, publisher: STORE.publisher, publisherDisplayName: STORE.publisherDisplayName });
  });

  it('give the test package an identity of its own, so it shares neither a package name nor a publisher with the Store one', () => {
    expect(identityOf('test')).toEqual({ name: TEST.name, publisher: TEST.publisher, publisherDisplayName: TEST.publisherDisplayName });
    expect(TEST.name).not.toBe(STORE.name);
    expect(TEST.publisher).not.toBe(STORE.publisher);
  });

  it('keep the full name of the owner as the Store publisher display name', () => {
    expect(PACKAGES.store.identity.publisherDisplayName).toBe('Pedro Miguel Rodrigues Jorge');
  });

  it('pass the checks for what Partner Center issues', () => {
    for (const kind of ['store', 'test'] as const) {
      expect(checkIdentity({ ...PACKAGES[kind].identity }), kind).toEqual(PACKAGES[kind].identity);
    }
  });

  it('cannot be changed from outside, and identityOf hands out a copy', () => {
    expect(Object.isFrozen(PACKAGES)).toBe(true);
    expect(Object.isFrozen(PACKAGES.store)).toBe(true);
    expect(Object.isFrozen(PACKAGES.store.identity)).toBe(true);
    expect(Object.isFrozen(PACKAGES.test.identity)).toBe(true);
    const copy = identityOf('store');
    copy.name = 'Changed.Name';
    expect(identityOf('store').name).toBe(STORE.name);
  });

  it('refuse a package that is not one of them, including names an object has of its own', () => {
    for (const kind of ['', 'Store', 'both', 'constructor', '__proto__', 'toString', undefined, null, 42]) {
      expect(messageOf(() => identityOf(kind)), String(kind)).toContain('Unknown package');
    }
  });
});

describe('checking an identity', () => {
  const valid = { name: STORE.name, publisher: STORE.publisher, publisherDisplayName: STORE.publisherDisplayName };

  it('wants a publisher that starts with CN=', () => {
    // The display name is what is pasted by mistake, so it is the first value to try.
    for (const publisher of ['Pedro Miguel Rodrigues Jorge', 'cn=00000000-0000-0000-0000-000000000000', '00000000-0000-0000-0000-000000000000', '', undefined]) {
      expect(messageOf(() => checkIdentity({ ...valid, publisher })), String(publisher)).toContain('must start with CN=');
    }
  });

  it('refuses a name the Store would turn away, and takes the ones it issues', () => {
    for (const name of ['ab', 'has space', 'under_score', 'Pedro&Co.App', 'x'.repeat(51), '', undefined]) {
      expect(messageOf(() => checkIdentity({ ...valid, name })), String(name)).toContain('Package/Identity/Name must be');
    }
    for (const name of ['PedroMiguelRodriguesJorge.zWorkTracker', 'rustcircle.zWorkTracker.Test', 'a-b.c', 'x'.repeat(50)]) {
      expect(checkIdentity({ ...valid, name }).name).toBe(name);
    }
  });
});

describe('the package family name', () => {
  // Windows names the folder a packaged app keeps its data in after this: %LOCALAPPDATA%\Packages\<package family name>.
  it('of the Store package is the one the README gives for its data folder', () => {
    expect(packageFamilyName(STORE.name, STORE.publisher)).toBe('PedroMiguelRodriguesJorge.zWorkTracker_54k2cbaqgvhqp');
    expect(packageFamilyName(STORE.name, STORE.publisher)).toBe(STORE.family);
  });

  it('of the test package is a different one, so the two never share a data folder', () => {
    expect(packageFamilyName(TEST.name, TEST.publisher)).toBe('rustcircle.zWorkTracker.Test_ym7m1j5c19s9r');
    expect(packageFamilyName(TEST.name, TEST.publisher)).toBe(TEST.family);
  });

  it('is what the identities in this script come to', () => {
    for (const [kind, want] of [['store', STORE], ['test', TEST]] as const) {
      const { name, publisher } = identityOf(kind);
      expect(packageFamilyName(name, publisher), kind).toBe(want.family);
    }
  });

  it('is the Name, an underscore and 13 characters of the id of the Publisher', () => {
    expect(publisherId(STORE.publisher)).toBe('54k2cbaqgvhqp');
    expect(publisherId(TEST.publisher)).toBe('ym7m1j5c19s9r');
    for (const publisher of [STORE.publisher, TEST.publisher, 'CN=x', 'CN="Pedro & Co", O=<Jorge>']) {
      expect(publisherId(publisher), publisher).toMatch(/^[0-9a-hjkmnp-tv-z]{13}$/);
      expect(packageFamilyName('Some.App', publisher)).toBe(`Some.App_${publisherId(publisher)}`);
    }
  });

  it('comes from the Publisher and not from the Name, and tells publishers that differ by a character apart', () => {
    expect(packageFamilyName('One.App', STORE.publisher).split('_')[1]).toBe(packageFamilyName('Another.App', STORE.publisher).split('_')[1]);
    const ids = new Set(['CN=zWorkTracker Test Signing', 'CN=zWorkTracker Test signing', 'CN=zWorkTracker Test Signing ', 'cn=zWorkTracker Test Signing'].map(publisherId));
    expect(ids.size).toBe(4);
  });

  it('reads the hash as 65 bits, 13 groups of 5 from the first group, each a character of 0123456789abcdefghjkmnpqrstvwxyz', () => {
    /**
     * The 8 bytes whose 64 bits, followed by the appended 0 bit, read as these thirteen 5-bit groups: twelve whole ones, and a
     * last one that is 4 bits of the hash and the appended 0. Worked out here bit by bit, not by the code that is tested.
     */
    function hashOf(first: readonly number[], last: number): Uint8Array {
      expect(first).toHaveLength(12);
      expect(last % 2, 'the last group ends in the appended 0 bit').toBe(0);
      const bits = first.map((group) => group.toString(2).padStart(5, '0')).join('') + (last >> 1).toString(2).padStart(4, '0');
      expect(bits).toHaveLength(64);
      return Uint8Array.from({ length: 8 }, (_, at) => parseInt(bits.slice(at * 8, at * 8 + 8), 2));
    }
    // Between them these rows use all 32 characters of the alphabet, in order.
    expect(encodePublisherHash(hashOf([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11], 12))).toBe('0123456789abc');
    expect(encodePublisherHash(hashOf([12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23], 24))).toBe('cdefghjkmnpqr');
    expect(encodePublisherHash(hashOf([24, 25, 26, 27, 28, 29, 30, 31, 0, 1, 2, 3], 30))).toBe('rstvwxyz0123y');
    // The 65th bit is a 0 and not part of the hash: 64 ones make twelve z and then 11110.
    expect(encodePublisherHash(new Uint8Array(8).fill(255))).toBe('zzzzzzzzzzzzy');
    expect(encodePublisherHash(new Uint8Array(8))).toBe('0000000000000');
    // The first byte is the most significant.
    expect(encodePublisherHash(Uint8Array.from([0x80, 0, 0, 0, 0, 0, 0, 0]))).toBe('g000000000000');
    expect(encodePublisherHash(Uint8Array.from([0, 0, 0, 0, 0, 0, 0, 1]))).toBe('000000000000' + '2');
  });

  it('wants 8 bytes of hash, a Publisher and a Name', () => {
    expect(messageOf(() => encodePublisherHash(new Uint8Array(7)))).toContain('8 bytes');
    expect(messageOf(() => encodePublisherHash(new Uint8Array(32)))).toContain('8 bytes');
    expect(messageOf(() => publisherId(''))).toContain('Publisher');
    expect(messageOf(() => publisherId(undefined))).toContain('Publisher');
    expect(messageOf(() => packageFamilyName('', STORE.publisher))).toContain('Name');
    expect(messageOf(() => packageFamilyName(undefined, STORE.publisher))).toContain('Name');
  });

  it('is the one the README gives for the data folder of the Store package, and of the test package', () => {
    const readme = readFileSync(resolve(import.meta.dirname, '../README.md'), 'utf8');
    // `includes` and not `toContain`, so that a failure does not print the whole README.
    const folder = `%LOCALAPPDATA%\\Packages\\${STORE.family}\\LocalCache\\Roaming\\com.rustcircle.zworktracker\\`;
    expect(readme.includes(folder), `README.md gives ${folder}`).toBe(true);
    expect(readme.includes(TEST.family), `README.md names ${TEST.family}`).toBe(true);
  });
});

describe('the files one run makes', () => {
  it('are named for the app, the package version, x64 and the package: store or test-unsigned', () => {
    expect(msixFileName('zWorkTracker', '1.3.3', 'store')).toBe(STORE.file);
    expect(msixFileName('zWorkTracker', '1.3.3', 'test')).toBe(TEST.file);
  });

  it('take the version with or without its fourth part, as the script has it after msixVersion', () => {
    expect(msixFileName('zWorkTracker', '1.3.3.0', 'store')).toBe(STORE.file);
    expect(msixFileName('zWorkTracker', msixVersion('1.3.3'), 'test')).toBe(TEST.file);
  });

  it('refuse a version the Store would turn away, and a package that is not one of the two', () => {
    expect(messageOf(() => msixFileName('zWorkTracker', '0.2.0', 'store'))).toContain('starts with 0');
    expect(messageOf(() => msixFileName('zWorkTracker', '1.3', 'test'))).toContain('is not a version the Store takes');
    expect(messageOf(() => msixFileName('zWorkTracker', '1.3.3', 'both'))).toContain('Unknown package');
  });

  it('differ from each other, so neither can overwrite the other', () => {
    expect(msixFileName('zWorkTracker', '1.3.3', 'store')).not.toBe(msixFileName('zWorkTracker', '1.3.3', 'test'));
  });
});

describe('the command line of the packaging script', () => {
  it('makes the Store package with no option', () => {
    expect(parseArguments([])).toEqual({ build: false, kinds: ['store'] });
  });

  it('takes --build, which is about the app and not about the packages', () => {
    expect(parseArguments(['--build'])).toEqual({ build: true, kinds: ['store'] });
    expect(parseArguments(['--build', '--identity', 'both'])).toEqual({ build: true, kinds: ['store', 'test'] });
  });

  it('lets --identity pick the Store package, the test package or both, with a space or an equals sign', () => {
    expect(parseArguments(['--identity', 'store']).kinds).toEqual(['store']);
    expect(parseArguments(['--identity=store']).kinds).toEqual(['store']);
    expect(parseArguments(['--identity', 'test']).kinds).toEqual(['test']);
    expect(parseArguments(['--identity=test']).kinds).toEqual(['test']);
    expect(parseArguments(['--identity', 'both']).kinds).toEqual(['store', 'test']);
    expect(parseArguments(['--identity=both']).kinds).toEqual(['store', 'test']);
  });

  it('takes the options in any order', () => {
    expect(parseArguments(['--identity=test', '--build'])).toEqual({ build: true, kinds: ['test'] });
    expect(parseArguments(['--build', '--identity', 'store'])).toEqual({ build: true, kinds: ['store'] });
  });

  it('hands out a list of its own each time', () => {
    parseArguments([]).kinds.push('test');
    expect(parseArguments([]).kinds).toEqual(['store']);
    parseArguments(['--identity', 'both']).kinds.push('store');
    expect(parseArguments(['--identity', 'both']).kinds).toEqual(['store', 'test']);
  });

  it('refuses a choice it does not know, including names an object has of its own', () => {
    for (const value of ['', 'Store', 'STORE', 'all', 'real', 'constructor', '__proto__', 'toString', 'hasOwnProperty']) {
      expect(messageOf(() => parseArguments([`--identity=${value}`])), value).toContain('--identity must be store, test or both');
      expect(messageOf(() => parseArguments(['--identity', value])), value).toContain('--identity must be store, test or both');
    }
  });

  it('refuses --identity with nothing after it, and does not take the next option for its value', () => {
    expect(messageOf(() => parseArguments(['--identity']))).toContain('got nothing');
    expect(messageOf(() => parseArguments(['--identity', '--build']))).toContain('got "--build"');
  });

  it('refuses a second --identity, which could only contradict the first', () => {
    expect(messageOf(() => parseArguments(['--identity=store', '--identity=test']))).toContain('more than once');
    expect(messageOf(() => parseArguments(['--identity', 'store', '--identity', 'store']))).toContain('more than once');
  });

  it('names every option it does not know, and says what the options are', () => {
    const message = messageOf(() => parseArguments(['--sign', '--build', 'store', '--identity=test']));
    expect(message).toContain('Unknown argument: --sign store');
    expect(message).toContain('--build');
    expect(message).toContain('--identity store|test|both');
    expect(messageOf(() => parseArguments(['--identity-store']))).toContain('Unknown argument: --identity-store');
  });
});

describe('the variables that named the Store identity before Partner Center issued it', () => {
  it('are reported when they are set, so a value left in a shell is not taken for an override', () => {
    const left = { ZWT_STORE_IDENTITY_NAME: 'rustcircle.zWorkTracker.Test', ZWT_STORE_PUBLISHER: 'CN=zWorkTracker Test Signing', ZWT_STORE_PUBLISHER_DISPLAY_NAME: 'zWorkTracker (test)' };
    expect(retiredVariables(left)).toEqual(['ZWT_STORE_IDENTITY_NAME', 'ZWT_STORE_PUBLISHER', 'ZWT_STORE_PUBLISHER_DISPLAY_NAME']);
    expect(retiredVariables({ ZWT_STORE_PUBLISHER: 'CN=Other' })).toEqual(['ZWT_STORE_PUBLISHER']);
  });

  it('are not reported when they are not set or are blank, and other variables are not looked at', () => {
    expect(retiredVariables({})).toEqual([]);
    expect(retiredVariables({ ZWT_STORE_IDENTITY_NAME: '   ', ZWT_STORE_PUBLISHER: '', ZWT_STORE_PUBLISHER_DISPLAY_NAME: undefined, ZWT_MSIX_OUT_DIR: '/tmp', PATH: '/usr/bin' })).toEqual([]);
  });
});

describe('AppxManifest.xml', () => {
  it('is well-formed XML that carries the identity, for x64', () => {
    const doc = parse(buildManifest(fields));
    expect(attrs(only(doc, NS.foundation, 'Identity'))).toEqual({
      Name: 'Placeholder.zWorkTracker',
      Publisher: 'CN=00000000-0000-0000-0000-000000000000',
      Version: '1.3.0.0',
      ProcessorArchitecture: 'x64',
    });
    expect(only(doc, NS.foundation, 'DisplayName').textContent).toBe('zWorkTracker');
    expect(only(doc, NS.foundation, 'PublisherDisplayName').textContent).toBe('Pedro Miguel Rodrigues Jorge');
  });

  it.each([
    ['store', STORE],
    ['test', TEST],
  ] as const)('of the %s package carries that package’s Identity Name, Publisher and Version, and its PublisherDisplayName', (kind, want) => {
    const doc = parse(manifestFor(kind, app));
    expect(attrs(only(doc, NS.foundation, 'Identity'))).toEqual({
      Name: want.name,
      Publisher: want.publisher,
      Version: '1.3.3.0',
      ProcessorArchitecture: 'x64',
    });
    expect(only(doc, NS.foundation, 'PublisherDisplayName').textContent).toBe(want.publisherDisplayName);
    expect(only(doc, NS.foundation, 'DisplayName').textContent).toBe('zWorkTracker');
  });

  it('of the Store package says the Store’s own values, as Partner Center prints them', () => {
    const xml = manifestFor('store', app);
    expect(xml).toContain('<Identity Name="PedroMiguelRodriguesJorge.zWorkTracker" Publisher="CN=1DEF8D7B-1D68-4604-8047-048DC92CF3A9" Version="1.3.3.0" ProcessorArchitecture="x64" />');
    expect(xml).toContain('<PublisherDisplayName>Pedro Miguel Rodrigues Jorge</PublisherDisplayName>');
  });

  it('of the two packages differ in the identity and the publisher display name, and in nothing else', () => {
    const bare = (xml: string): string => xml.replace(/<Identity [^>]*>/, '<Identity />').replace(/<PublisherDisplayName>[^<]*</, '<PublisherDisplayName><');
    const store = manifestFor('store', app);
    const test = manifestFor('test', app);
    expect(store).not.toBe(test);
    expect(bare(store)).toBe(bare(test));
    // So both are full-trust, with the same logos and the same startup task.
    for (const xml of [store, test]) {
      const doc = parse(xml);
      expect(attrs(only(doc, NS.rescap, 'Capability'))).toEqual({ Name: 'runFullTrust' });
      expect(only(doc, NS.foundation, 'Logo').textContent).toBe('Assets\\StoreLogo.png');
      expect(attrs(only(doc, NS.desktop, 'StartupTask'))).toEqual({ TaskId: 'zWorkTrackerStartup', Enabled: 'false', DisplayName: 'zWorkTracker' });
    }
  });

  it('of a package that is not one of the two is refused, rather than built with no identity', () => {
    for (const kind of ['', 'both', 'constructor', undefined]) expect(messageOf(() => manifestFor(kind, app)), String(kind)).toContain('Unknown package');
  });

  it('takes the version of the app as tauri.conf.json has it, and makes the Store’s package version of it', () => {
    const conf: unknown = JSON.parse(readFileSync(resolve(import.meta.dirname, '../src-tauri/tauri.conf.json'), 'utf8'));
    const version = typeof conf === 'object' && conf !== null && 'version' in conf ? conf.version : undefined;
    expect(typeof version).toBe('string');
    expect(msixVersion(version)).toBe(`${String(version)}.0`);
  });

  it('declares the namespaces it uses, and marks the ones Windows 10 does not need to know as ignorable', () => {
    const root = parse(buildManifest(fields)).documentElement;
    expect(root.namespaceURI).toBe(NS.foundation);
    expect(root.localName).toBe('Package');
    expect(root.lookupNamespaceURI('uap')).toBe(NS.uap);
    expect(root.lookupNamespaceURI('rescap')).toBe(NS.rescap);
    expect(root.lookupNamespaceURI('desktop')).toBe(NS.desktop);
    expect(root.getAttribute('IgnorableNamespaces')).toBe('uap rescap desktop');
  });

  it('is a full-trust program for Windows desktop 10.0.19041 and later', () => {
    const doc = parse(buildManifest(fields));
    expect(attrs(only(doc, NS.foundation, 'TargetDeviceFamily'))).toEqual({
      Name: 'Windows.Desktop',
      MinVersion: '10.0.19041.0',
      MaxVersionTested: '10.0.26100.0',
    });
    expect(attrs(only(doc, NS.foundation, 'Resource'))).toEqual({ Language: 'en-us' });
    expect(attrs(only(doc, NS.foundation, 'Application'))).toEqual({
      Id: 'zWorkTracker',
      Executable: 'zWorkTracker.exe',
      EntryPoint: 'Windows.FullTrustApplication',
    });
    expect(attrs(only(doc, NS.rescap, 'Capability'))).toEqual({ Name: 'runFullTrust' });
  });

  it('names its logo and tiles in the Assets folder', () => {
    const doc = parse(buildManifest(fields));
    expect(only(doc, NS.foundation, 'Logo').textContent).toBe('Assets\\StoreLogo.png');
    expect(attrs(only(doc, NS.uap, 'VisualElements'))).toEqual({
      DisplayName: 'zWorkTracker',
      Description: 'Labor hours tracker',
      BackgroundColor: 'transparent',
      Square150x150Logo: 'Assets\\Square150x150Logo.png',
      Square44x44Logo: 'Assets\\Square44x44Logo.png',
    });
  });

  it('names exactly the base images the packaging script cuts, each at the base size of its kind', () => {
    expect(ASSETS).toEqual({ StoreLogo: 50, Square44x44Logo: 44, Square150x150Logo: 150 });
    const named = [...buildManifest(fields).matchAll(/Assets\\([A-Za-z0-9]+)\.png/g)].map((m) => m[1]);
    expect(named.sort()).toEqual(Object.keys(ASSETS).sort());
  });

  it('declares a startup task that stays off until the user turns it on in Windows', () => {
    const doc = parse(buildManifest(fields));
    const extension = only(doc, NS.desktop, 'Extension');
    expect(attrs(extension)).toEqual({
      Category: 'windows.startupTask',
      Executable: 'zWorkTracker.exe',
      EntryPoint: 'Windows.FullTrustApplication',
    });
    expect(extension.parentElement?.localName).toBe('Extensions');
    expect(extension.parentElement?.parentElement?.localName).toBe('Application');
    const task = only(doc, NS.desktop, 'StartupTask');
    expect(task.parentElement).toBe(extension);
    expect(attrs(task)).toEqual({ TaskId: 'zWorkTrackerStartup', Enabled: 'false', DisplayName: 'zWorkTracker' });
  });

  it('writes the four-part version, whichever form it was given', () => {
    for (const version of ['1.3.0', '1.3.0.0']) {
      expect(attrs(only(parse(buildManifest({ ...fields, version })), NS.foundation, 'Identity')).Version).toBe('1.3.0.0');
    }
  });

  it('refuses a version the Store would turn away', () => {
    for (const version of ['0.2.0', '1.3', '1.3.0.1', '']) {
      expect(messageOf(() => buildManifest({ ...fields, version })), version).toContain('Store');
    }
  });

  it('escapes every value, so none can add markup', () => {
    const tricky = {
      ...fields,
      publisher: 'CN="Pedro & Co", O=<Jorge>',
      publisherDisplayName: `"/><Injected a='x'/><x y="`,
      displayName: `A & B <C> "D" 'E'`,
      description: 'Fish & chips </Description><Injected/>',
    };
    const xml = buildManifest(tricky);
    const doc = parse(xml);
    expect(doc.getElementsByTagName('Injected')).toHaveLength(0);
    expect(only(doc, NS.foundation, 'Identity').getAttribute('Publisher')).toBe(tricky.publisher);
    expect(only(doc, NS.foundation, 'PublisherDisplayName').textContent).toBe(tricky.publisherDisplayName);
    expect(only(doc, NS.foundation, 'DisplayName').textContent).toBe(tricky.displayName);
    expect(only(doc, NS.uap, 'VisualElements').getAttribute('Description')).toBe(tricky.description);
    expect(only(doc, NS.desktop, 'StartupTask').getAttribute('DisplayName')).toBe(tricky.displayName);
    expect(xml).toContain('Publisher="CN=&quot;Pedro &amp; Co&quot;, O=&lt;Jorge&gt;"');
  });

  it('names the field when a value is empty or holds a character XML does not allow', () => {
    for (const field of ['name', 'publisher', 'publisherDisplayName', 'displayName', 'description'] as const) {
      expect(messageOf(() => buildManifest({ ...fields, [field]: '  ' })), field).toContain(`needs a ${field}`);
      for (const bad of ['a\u0001b', 'a\u0000b', 'a\uFFFEb', 'a\uFFFFb']) {
        expect(messageOf(() => buildManifest({ ...fields, [field]: bad })), field).toContain(`${field} has a character that XML does not allow`);
      }
    }
    expect(() => buildManifest({ ...fields, description: 'one\ttwo\nthree\r\nfour' })).not.toThrow();
  });
});

/** The plain image the manifest names for each logo, with its base size. */
const BASE_IMAGES = { StoreLogo: 50, Square44x44Logo: 44, Square150x150Logo: 150 };
/**
 * The images that must be in Assets, as Microsoft lists them in "Construct your Windows App's Icon" (Windows app design, iconography),
 * written out here and not read from the module, so that a change to the list fails a test. [logo, percent, pixels] is its table of
 * the manifest entries at each display scale, with halves rounded up: 150 px at 125% is 188.
 */
const AT_SCALE: readonly (readonly [logo: keyof typeof BASE_IMAGES, percent: number, pixels: number])[] = [
  ['StoreLogo', 100, 50], ['StoreLogo', 125, 63], ['StoreLogo', 150, 75], ['StoreLogo', 200, 100], ['StoreLogo', 400, 200],
  ['Square44x44Logo', 100, 44], ['Square44x44Logo', 125, 55], ['Square44x44Logo', 150, 66], ['Square44x44Logo', 200, 88], ['Square44x44Logo', 400, 176],
  ['Square150x150Logo', 100, 150], ['Square150x150Logo', 125, 188], ['Square150x150Logo', 150, 225], ['Square150x150Logo', 200, 300], ['Square150x150Logo', 400, 600],
];
/** The sides, in pixels, at which the shell asks for the app icon; each comes plain, unplated (dark theme) and light-unplated. */
const TARGET_SIDES = [16, 20, 24, 30, 32, 36, 40, 48, 60, 64, 72, 80, 96, 256];
const TARGET_FORMS = ['', '_altform-unplated', '_altform-lightunplated'];

/** Every image Assets must hold, with the side in pixels it must have: 3 plain, 15 for display scales and 42 for the taskbar and Start. */
function expectedImages(): Map<string, number> {
  const images = new Map<string, number>();
  for (const [logo, size] of Object.entries(BASE_IMAGES)) images.set(`Assets/${logo}.png`, size);
  for (const [logo, percent, pixels] of AT_SCALE) images.set(`Assets/${logo}.scale-${percent}.png`, pixels);
  for (const side of TARGET_SIDES) {
    for (const form of TARGET_FORMS) images.set(`Assets/Square44x44Logo.targetsize-${side}${form}.png`, side);
  }
  return images;
}

describe('the images in Assets', () => {
  const kinds = ['store', 'test'] as const;
  const images = assetImages();
  const names = images.map(({ name }) => name);
  const sizes = new Map(images.map(({ name, size }) => [name, size]));

  it('are the 60 images Windows picks from, and no others', () => {
    expect(expectedImages().size).toBe(60);
    expect(names).toHaveLength(60);
    expect([...names].sort()).toEqual([...expectedImages().keys()].sort());
  });

  it('are each cut at the side in pixels that its name asks for', () => {
    for (const [name, size] of expectedImages()) expect(sizes.get(name), name).toBe(size);
  });

  it('are named as Windows looks for them, which a sample spelled out whole shows', () => {
    // Whole names, so that a mistake in how the module builds them is not repeated by the way this test builds them.
    const sample: [string, number][] = [
      ['Assets/Square44x44Logo.png', 44],
      ['Assets/Square150x150Logo.png', 150],
      ['Assets/StoreLogo.png', 50],
      ['Assets/Square44x44Logo.scale-100.png', 44],
      ['Assets/Square44x44Logo.scale-400.png', 176],
      ['Assets/Square150x150Logo.scale-125.png', 188],
      ['Assets/StoreLogo.scale-125.png', 63],
      ['Assets/StoreLogo.scale-400.png', 200],
      ['Assets/Square44x44Logo.targetsize-16.png', 16],
      ['Assets/Square44x44Logo.targetsize-16_altform-unplated.png', 16],
      ['Assets/Square44x44Logo.targetsize-24_altform-unplated.png', 24],
      ['Assets/Square44x44Logo.targetsize-30_altform-lightunplated.png', 30],
      ['Assets/Square44x44Logo.targetsize-48_altform-lightunplated.png', 48],
      ['Assets/Square44x44Logo.targetsize-256_altform-unplated.png', 256],
      ['Assets/Square44x44Logo.targetsize-256_altform-lightunplated.png', 256],
    ];
    for (const [name, size] of sample) expect(sizes.get(name), name).toBe(size);
  });

  it('are each named once, in the Assets folder, with forward slashes and a .png ending', () => {
    expect(new Set(names).size).toBe(names.length);
    const shape = /^Assets\/(StoreLogo|Square44x44Logo|Square150x150Logo)(\.(scale|targetsize)-\d+(_altform-(unplated|lightunplated))?)?\.png$/;
    for (const name of names) expect(shape.test(name), name).toBe(true);
  });

  it('round half up from the base size, as in Microsoft’s table', () => {
    for (const [logo, percent, pixels] of AT_SCALE) expect(scaledSize(BASE_IMAGES[logo], percent), `${logo} at ${percent}%`).toBe(pixels);
    expect(scaledSize(150, 125)).toBe(188);
    expect(scaledSize(50, 125)).toBe(63);
  });

  it('include the plain image that the manifest of each package names for each logo, which stays beside the variants', () => {
    for (const kind of kinds) {
      const named = [...manifestFor(kind, app).matchAll(/Assets\\([A-Za-z0-9]+)\.png/g)].map((m) => `Assets/${m[1]}.png`);
      expect([...named].sort(), kind).toEqual(Object.keys(BASE_IMAGES).map((logo) => `Assets/${logo}.png`).sort());
      for (const name of named) expect(sizes.has(name), `${kind}: ${name}`).toBe(true);
    }
  });

  it('are none lacking from the file list of a package that holds them all', () => {
    // A package's file list, as `unzip -Z1` prints it: what makemsix adds, the app, and the images.
    const entries = ['AppxBlockMap.xml', '[Content_Types].xml', 'AppxManifest.xml', 'zWorkTracker.exe', 'WebView2Loader.dll', ...expectedImages().keys()];
    expect(lackingAssets(entries)).toEqual([]);
  });

  it('are each reported by name when a package lacks it, a variant as much as a plain image', () => {
    for (const name of expectedImages().keys()) {
      const without = ['AppxManifest.xml', ...[...expectedImages().keys()].filter((other) => other !== name)];
      expect(lackingAssets(without), name).toEqual([name]);
    }
    // With only the three plain images, which is what 1.3.2 had and what left the plate on, the other 57 are lacking.
    const lacking = lackingAssets(Object.keys(BASE_IMAGES).map((logo) => `Assets/${logo}.png`));
    expect(lacking).toHaveLength(57);
    expect(lacking).toContain('Assets/Square44x44Logo.targetsize-24_altform-unplated.png');
    expect(lackingAssets([])).toHaveLength(60);
  });

  it('are lacking when they are in another folder of the package, as a name is looked for whole', () => {
    expect(lackingAssets([...expectedImages().keys()].map((name) => name.replace('Assets/', 'Assets/sub/')))).toHaveLength(60);
  });
});

describe('the resource index of a package, resources.pri', () => {
  const utf16 = (text: string) => Buffer.from(text, 'utf16le');
  /** The path of every image as makepri writes it into an index: 8-bit text with a backslash, as Microsoft's own two indexes hold theirs. */
  const imagePaths = assetImages().map(({ name }) => name.replace('/', '\\'));
  /**
   * Something shaped like what makepri writes, as read off Microsoft's own resources.pri: the eight bytes of the magic first and last,
   * section tags, the name of the resource map as UTF-16LE both as ms-appx://<name>/ and on its own, the path of each of `images` (all 60 by
   * default) and 0xDEFFFADE and a size before the closing magic. A `name` of null leaves the name out.
   */
  function pri(name: string | null, magic = 'mrm_pri2', images: readonly string[] = imagePaths): Buffer {
    return Buffer.concat([
      Buffer.from(magic, 'latin1'),
      Buffer.alloc(24),
      Buffer.from('[mrm_decn_info][mrm_hschemaex] ', 'latin1'),
      name === null ? Buffer.alloc(0) : Buffer.concat([utf16(`ms-appx://${name}/`), Buffer.alloc(8), utf16(name)]),
      Buffer.from('[mrm_dataitem] ', 'latin1'),
      ...images.flatMap((path) => [Buffer.from(path, 'latin1'), Buffer.alloc(1)]),
      Buffer.alloc(16),
      Buffer.from('defaffde', 'hex'),
      Buffer.alloc(4),
      Buffer.from(magic, 'latin1'),
    ]);
  }
  const packages = [
    ['store', STORE],
    ['test', TEST],
  ] as const;

  it.each(packages)('takes a file that starts like a PRI file and names the identity of the %s package, and hands its bytes back', (kind, identity) => {
    const bytes = pri(identity.name);
    expect(checkResourceIndex(kind, bytes)).toBe(bytes);
  });

  it('is called resources.pri', () => {
    expect(RESOURCE_INDEX).toBe('resources.pri');
  });

  it('refuses a file that is empty', () => {
    expect(messageOf(() => checkResourceIndex('store', Buffer.alloc(0)))).toBe('it is empty.');
  });

  it('refuses a file that does not start with mrm_pri2, whatever else it holds, and shows what it starts with', () => {
    const body = pri(STORE.name).subarray(8);
    const wrong: [string, Buffer, string][] = [
      ['the priconfig.xml it was made from', Buffer.from('<?xml version="1.0" encoding="utf-8"?><resources targetOsVersion="10.0.0"/>'), '"<?xml ve"'],
      ['a zip file', Buffer.concat([Buffer.from('504b0304', 'hex'), body]), '"PK\\x03\\x04\\x00\\x00\\x00\\x00"'],
      ['a web page, as saved from a failed download', Buffer.from('<!DOCTYPE html><title>Not found</title>'), '"<!DOCTYP"'],
      ['the magic after other bytes', Buffer.concat([Buffer.from('  '), pri(STORE.name)]), '"  mrm_pr"'],
      ['the magic cut short', Buffer.concat([Buffer.from('mrm_pri'), body]), '"mrm_pri\\x00"'],
      ['another version of the magic', pri(STORE.name, 'mrm_pri0'), '"mrm_pri0"'],
      ['three bytes', Buffer.from('mrm'), '"mrm"'],
    ];
    for (const [what, bytes, shown] of wrong) {
      const message = messageOf(() => checkResourceIndex('store', bytes));
      expect(message, what).toContain('it is not a PRI file');
      expect(message, what).toContain(shown);
      expect(message, what).toContain('starts with mrm_pri2');
    }
  });

  it('refuses the index of the other package, in both directions, and says whose it names', () => {
    const forTest = messageOf(() => checkResourceIndex('store', pri(TEST.name)));
    expect(forTest).toContain(`it names the identity of the test package, ${TEST.name}, and the store package's is ${STORE.name}.`);
    const forStore = messageOf(() => checkResourceIndex('test', pri(STORE.name)));
    expect(forStore).toContain(`it names the identity of the store package, ${STORE.name}, and the test package's is ${TEST.name}.`);
  });

  it('refuses an index that names both identities, since it cannot be told which package it is for', () => {
    const both = Buffer.concat([pri(STORE.name), pri(TEST.name)]);
    for (const [kind] of packages) expect(messageOf(() => checkResourceIndex(kind, both)), kind).toContain('it names the identity of the');
  });

  it.each(packages)('refuses an index that names neither identity, made from another manifest, and says which name the %s package wants', (kind, identity) => {
    for (const bytes of [pri('Placeholder.zWorkTracker'), pri(null)]) {
      expect(messageOf(() => checkResourceIndex(kind, bytes))).toContain(`it does not name the identity of the ${kind} package, ${identity.name}.`);
    }
  });

  it('looks for the name as makepri writes it, in UTF-16LE: the letters as single bytes do not count, nor part of the name', () => {
    const magic = Buffer.concat([Buffer.from('mrm_pri2', 'latin1'), Buffer.alloc(24)]);
    expect(() => checkResourceIndex('store', Buffer.concat([magic, Buffer.from(STORE.name, 'latin1')]))).toThrow('does not name the identity of the store package');
    expect(() => checkResourceIndex('store', Buffer.concat([magic, utf16(STORE.name.slice(0, -1))]))).toThrow('does not name the identity of the store package');
    // Where the name sits does not matter, an odd offset included: no layout of the file is assumed beyond how it starts.
    expect(() => checkResourceIndex('store', Buffer.concat([magic, Buffer.from('x'), utf16(STORE.name)]))).not.toThrow();
  });

  it('names the variable that can point to the index of each package', () => {
    expect(resourceIndexVariable('store')).toBe('ZWT_MSIX_PRI_STORE');
    expect(resourceIndexVariable('test')).toBe('ZWT_MSIX_PRI_TEST');
  });

  it('refuses a package that is not one of the two, including names an object has of its own', () => {
    for (const kind of ['both', 'constructor', '__proto__', 'toString', '', 42, null, undefined]) {
      expect(messageOf(() => resourceIndexVariable(kind)), String(kind)).toContain('Unknown package');
      expect(messageOf(() => checkResourceIndex(kind, pri(STORE.name))), String(kind)).toContain('Unknown package');
      expect(messageOf(() => resourceIndexFor(kind, { env: {}, root: '/work', read: () => null })), String(kind)).toContain('Unknown package');
    }
  });

  describe('looked for, in a made-up file system', () => {
    const root = resolve('/work/repo');
    const usual = (kind: string) => join(root, 'packaging', 'msix', kind, 'resources.pri');
    /** A reader over a made-up disk: the bytes of each path in `files`, null for any other, and the paths it was asked for. */
    function disk(files: Record<string, Buffer>) {
      const asked: string[] = [];
      return {
        asked,
        read: (file: string): Buffer | null => {
          asked.push(file);
          return Object.hasOwn(files, file) ? (files[file] ?? null) : null;
        },
      };
    }

    it.each(packages)('finds the index of the %s package at packaging/msix/<package>/resources.pri in the repo, checked and whole', (kind, identity) => {
      const bytes = pri(identity.name);
      const { read, asked } = disk({ [usual(kind)]: bytes });
      expect(resourceIndexFor(kind, { env: {}, root, read })).toEqual({ file: usual(kind), bytes, variable: null });
      expect(asked).toEqual([usual(kind)]);
    });

    it('is none, and no error, when there is no file at the usual place, and does not look at the other package\'s', () => {
      expect(resourceIndexFor('store', { env: {}, root, read: () => null })).toBeNull();
      const { read, asked } = disk({ [usual('store')]: pri(STORE.name) });
      expect(resourceIndexFor('test', { env: {}, root, read })).toBeNull();
      expect(asked).toEqual([usual('test')]);
    });

    it('takes the file that the variable names instead of the one in the repo, and says which variable named it', () => {
      const named = resolve('/elsewhere/store.pri');
      const bytes = pri(STORE.name);
      const { read, asked } = disk({ [named]: bytes, [usual('store')]: Buffer.from('not looked at') });
      expect(resourceIndexFor('store', { env: { ZWT_MSIX_PRI_STORE: named }, root, read })).toEqual({ file: named, bytes, variable: 'ZWT_MSIX_PRI_STORE' });
      expect(asked).toEqual([named]);
    });

    it('reads a relative path in the variable against the folder it is run in, as a shell would', () => {
      const bytes = pri(TEST.name);
      const { read } = disk({ [resolve('my.pri')]: bytes });
      expect(resourceIndexFor('test', { env: { ZWT_MSIX_PRI_TEST: ' my.pri ' }, root, read })?.file).toBe(resolve('my.pri'));
    });

    it('takes a variable that is not set, empty or blank for no variable, and ignores the variable of the other package', () => {
      const bytes = pri(STORE.name);
      for (const env of [{}, { ZWT_MSIX_PRI_STORE: undefined }, { ZWT_MSIX_PRI_STORE: '' }, { ZWT_MSIX_PRI_STORE: '  \t' }, { ZWT_MSIX_PRI_TEST: resolve('/elsewhere/test.pri') }]) {
        const { read } = disk({ [usual('store')]: bytes });
        expect(resourceIndexFor('store', { env, root, read }), JSON.stringify(env)).toEqual({ file: usual('store'), bytes, variable: null });
      }
    });

    it('refuses a variable that names a file that is not there, since that cannot mean no index', () => {
      const named = resolve('/elsewhere/missing.pri');
      const message = messageOf(() => resourceIndexFor('store', { env: { ZWT_MSIX_PRI_STORE: named }, root, read: disk({ [usual('store')]: pri(STORE.name) }).read }));
      expect(message).toBe(`ZWT_MSIX_PRI_STORE names ${named}, which is not there.`);
    });

    it('refuses a file that is not the index of the package, at the usual place or named by a variable, saying which file and which package', () => {
      const message = messageOf(() => resourceIndexFor('store', { env: {}, root, read: disk({ [usual('store')]: pri(TEST.name) }).read }));
      expect(message).toBe(`${usual('store')} cannot be the resource index of the store package: it names the identity of the test package, ${TEST.name}, and the store package's is ${STORE.name}. Windows uses an index only for the package whose name it holds.`);
      const named = resolve('/elsewhere/test.pri');
      const viaVariable = messageOf(() => resourceIndexFor('test', { env: { ZWT_MSIX_PRI_TEST: named }, root, read: disk({ [named]: Buffer.alloc(0) }).read }));
      expect(viaVariable).toBe(`${named} cannot be the resource index of the test package: it is empty.`);
    });

    it('refuses an index that names the identity but lacks an image of the package, as one made before the set of images changed does', () => {
      // 1.3.2 had the three plain images only; an index made for them would pass for the identity and leave the other 57 to be found nowhere.
      const old = pri(STORE.name, 'mrm_pri2', imagePaths.slice(0, 3));
      expect(messageOf(() => resourceIndexFor('store', { env: {}, root, read: disk({ [usual('store')]: old }).read }))).toBe(
        `${usual('store')} cannot be the resource index of the store package: it does not list 57 of the 60 images of a package (Assets/StoreLogo.scale-100.png, Assets/StoreLogo.scale-125.png, Assets/StoreLogo.scale-150.png and 54 more). ` +
          'An index lists the images that were there when it was made, so this one was made for another set of images, and Windows would not find those through it. Make it again with pnpm msix:pri.',
      );
      // One image missing is enough, and it is named.
      const one = pri(TEST.name, 'mrm_pri2', imagePaths.filter((path) => !path.includes('targetsize-48_altform-unplated')));
      const named = resolve('/elsewhere/test.pri');
      expect(messageOf(() => resourceIndexFor('test', { env: { ZWT_MSIX_PRI_TEST: named }, root, read: disk({ [named]: one }).read }))).toContain(
        `${named} cannot be the resource index of the test package: it does not list 1 of the 60 images of a package (Assets/Square44x44Logo.targetsize-48_altform-unplated.png).`,
      );
    });

    it('names the wrong identity before the lacking images, when an index has both faults', () => {
      const both = pri(TEST.name, 'mrm_pri2', []);
      expect(messageOf(() => resourceIndexFor('store', { env: {}, root, read: disk({ [usual('store')]: both }).read }))).toContain('it names the identity of the test package');
    });

    it('says which file could not be read, and why, when reading it fails for another reason than that it is missing', () => {
      const read = (): Buffer => {
        throw new Error('EISDIR: illegal operation on a directory, read');
      };
      expect(messageOf(() => resourceIndexFor('store', { env: {}, root, read }))).toBe(`Could not read ${usual('store')}: EISDIR: illegal operation on a directory, read`);
    });
  });
});

describe('reading a PNG header', () => {
  /** One chunk of a PNG file: its length, its name, its data and a checksum. The checksum is left empty, as nothing here reads it. */
  function chunk(type: string, data: Buffer): Buffer {
    const head = Buffer.alloc(8);
    head.writeUInt32BE(data.length, 0);
    head.write(type, 4, 'latin1');
    return Buffer.concat([head, data, Buffer.alloc(4)]);
  }
  /** The start of a PNG file of this colour type: the signature, the header, the `before` chunks, one pixel chunk, the `after` chunks and the end. */
  function png(colourType: number, { width = 16, height = 16, before = [], after = [] }: { width?: number; height?: number; before?: Buffer[]; after?: Buffer[] } = {}): Buffer {
    const header = Buffer.alloc(13);
    header.writeUInt32BE(width, 0);
    header.writeUInt32BE(height, 4);
    header[8] = 8;
    header[9] = colourType;
    return Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', header), ...before, chunk('IDAT', Buffer.alloc(4)), ...after, chunk('IEND', Buffer.alloc(0))]);
  }
  const transparentColour = chunk('tRNS', Buffer.from([0, 0, 0, 0, 0, 0]));

  it('reads the width and the height', () => {
    expect(pngInfo(png(6, { width: 600, height: 600 }))).toEqual({ width: 600, height: 600, alpha: true });
    expect(pngInfo(png(6, { width: 24, height: 40 }))).toEqual({ width: 24, height: 40, alpha: true });
  });

  it('says an image with an alpha channel can be transparent: grey with alpha, and RGBA', () => {
    expect(pngInfo(png(4))?.alpha).toBe(true);
    expect(pngInfo(png(6))?.alpha).toBe(true);
  });

  it('says an image with no alpha channel and no tRNS chunk cannot be: grey, RGB and palette', () => {
    for (const colourType of [0, 2, 3]) expect(pngInfo(png(colourType))?.alpha, `colour type ${colourType}`).toBe(false);
  });

  it('says an image can be transparent when a tRNS chunk before the pixels declares a transparent colour', () => {
    for (const colourType of [0, 2, 3]) expect(pngInfo(png(colourType, { before: [transparentColour] }))?.alpha, `colour type ${colourType}`).toBe(true);
    // A chunk between the header and the pixels that is not tRNS changes nothing, and one after the pixels is too late to count.
    expect(pngInfo(png(2, { before: [chunk('gAMA', Buffer.alloc(4))] }))?.alpha).toBe(false);
    expect(pngInfo(png(2, { after: [transparentColour] }))?.alpha).toBe(false);
  });

  it('is null for what does not start like a PNG, instead of reading a size from it', () => {
    const whole = png(6);
    expect(pngInfo(Buffer.alloc(0))).toBeNull();
    expect(pngInfo(Buffer.from('GIF89a'))).toBeNull();
    expect(pngInfo(whole.subarray(0, 32))).toBeNull();
    expect(pngInfo(Buffer.concat([Buffer.from('89504e470d0a1a0b', 'hex'), whole.subarray(8)]))).toBeNull();
    expect(pngInfo(Buffer.concat([whole.subarray(0, 12), Buffer.from('IHDX'), whole.subarray(16)]))).toBeNull();
  });

  it('does not run off the end of a file that is cut short after its header', () => {
    expect(pngInfo(png(2).subarray(0, 33))).toEqual({ width: 16, height: 16, alpha: false });
    expect(pngInfo(png(2).subarray(0, 38))).toEqual({ width: 16, height: 16, alpha: false });
  });

  it('finds the app icon, which the logos are cut from, square and able to be transparent', () => {
    const info = pngInfo(readFileSync(resolve(import.meta.dirname, '../src-tauri/icons/icon.png')));
    expect(info?.alpha, 'src-tauri/icons/icon.png has no transparency, so the images cut from it would be drawn as solid squares').toBe(true);
    expect(info?.width).toBe(info?.height);
    // The biggest taskbar icon is 256 px, which is then cut down and never enlarged.
    expect(info?.width).toBeGreaterThanOrEqual(256);
  });
});

describe('the files that ship with the app', () => {
  const tauri = resolve('/work/src-tauri');

  it('puts each resource where the config says, reading the keys from src-tauri', () => {
    const resources = { '../LICENSE': 'licenses/LICENSE', 'crates/z-work-core/fonts/OFL.txt': 'licenses/NotoSans-OFL.txt' };
    expect(resourceCopies(resources, tauri)).toEqual([
      { from: resolve(tauri, '../LICENSE'), to: 'licenses/LICENSE' },
      { from: resolve(tauri, 'crates/z-work-core/fonts/OFL.txt'), to: 'licenses/NotoSans-OFL.txt' },
    ]);
  });

  it('tidies a destination that is still inside the app', () => {
    const to = (name: string) => resourceCopies({ '../LICENSE': name }, tauri)[0]?.to;
    expect(to('./licenses//LICENSE')).toBe('licenses/LICENSE');
    expect(to('a/../LICENSE')).toBe('LICENSE');
  });

  it('refuses a destination that is not a file name inside the app', () => {
    for (const to of ['../evil', 'a/../../evil', '/etc/evil', 'licenses\\LICENSE', 'licenses/', '', '.', '..', 42, null, undefined]) {
      expect(messageOf(() => resourceCopies({ '../LICENSE': to }, tauri)), String(to)).toContain('not a file name inside the app');
    }
  });

  it('refuses resources that are missing, empty or not a map, since the licenses ship from there', () => {
    for (const resources of [undefined, null, {}, ['../LICENSE'], '../LICENSE']) {
      expect(messageOf(() => resourceCopies(resources, tauri)), JSON.stringify(resources)).toContain('must map each file');
    }
  });
});

describe('the version inside an exe', () => {
  /**
   * A String entry of a version resource as the resource compiler lays it out: three header words, the key and the value,
   * both UTF-16 and ending in a zero word, the value starting on a 4-byte boundary.
   */
  function entry(key: string, value: string): Buffer {
    const keyBytes = Buffer.from(`${key}\0`, 'utf16le');
    const padding = Buffer.alloc((4 - ((6 + keyBytes.length) % 4)) % 4);
    return Buffer.concat([Buffer.alloc(6), keyBytes, padding, Buffer.from(`${value}\0`, 'utf16le')]);
  }
  /** Something shaped like an exe: some bytes, the entries, some more bytes. */
  function exeWith(...entries: Buffer[]): Buffer {
    return Buffer.concat([Buffer.alloc(64, 0xff), ...entries, Buffer.alloc(32, 0xff)]);
  }

  it('reads the ProductVersion, not the entries around it', () => {
    const exe = exeWith(entry('FileVersion', '9.9.9'), entry('ProductVersion', '1.3.0'), entry('ProductName', 'zWorkTracker'));
    expect(embeddedVersion(exe)).toBe('1.3.0');
    expect(embeddedVersion(exeWith(entry('ProductVersion', '10.20.30')))).toBe('10.20.30');
  });

  it('is null when there is no ProductVersion, instead of another version', () => {
    expect(embeddedVersion(exeWith(entry('FileVersion', '1.3.0')))).toBeNull();
    expect(embeddedVersion(Buffer.from('MZ not really an exe'))).toBeNull();
    expect(embeddedVersion(Buffer.alloc(0))).toBeNull();
  });

  it('is null when the value is empty or runs off the end of the file', () => {
    expect(embeddedVersion(exeWith(entry('ProductVersion', '')))).toBeNull();
    const cutOff = Buffer.concat([Buffer.alloc(64, 0xff), Buffer.from('ProductVersion\0', 'utf16le'), Buffer.from('1.3.0', 'utf16le')]);
    expect(embeddedVersion(cutOff)).toBeNull();
  });

  it('returns the value as written, without tidying it', () => {
    expect(embeddedVersion(exeWith(entry('ProductVersion', '0.2.0')))).toBe('0.2.0');
    expect(embeddedVersion(exeWith(entry('ProductVersion', '1.3.0.0')))).toBe('1.3.0.0');
  });
});
