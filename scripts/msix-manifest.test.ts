// @vitest-environment jsdom
// jsdom for DOMParser: the manifest is read back as XML, so what is checked is what a reader of the package would see.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  ASSETS,
  PACKAGES,
  buildManifest,
  checkIdentity,
  embeddedVersion,
  encodePublisherHash,
  identityOf,
  manifestFor,
  msixFileName,
  msixVersion,
  packageFamilyName,
  parseArguments,
  publisherId,
  resourceCopies,
  retiredVariables,
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
  file: 'zWorkTracker_1.3.2.0_x64_store.msix',
};
/** The identity of the package made for trying the app on a PC. Its Publisher is the subject of the certificate it is signed with. */
const TEST = {
  name: 'rustcircle.zWorkTracker.Test',
  publisher: 'CN=zWorkTracker Test Signing',
  publisherDisplayName: 'zWorkTracker (test)',
  family: 'rustcircle.zWorkTracker.Test_ym7m1j5c19s9r',
  file: 'zWorkTracker_1.3.2.0_x64_test-unsigned.msix',
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
const app = { displayName: 'zWorkTracker', description: 'Labor hours tracker', version: '1.3.2' };

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
    expect(msixFileName('zWorkTracker', '1.3.2', 'store')).toBe(STORE.file);
    expect(msixFileName('zWorkTracker', '1.3.2', 'test')).toBe(TEST.file);
  });

  it('take the version with or without its fourth part, as the script has it after msixVersion', () => {
    expect(msixFileName('zWorkTracker', '1.3.2.0', 'store')).toBe(STORE.file);
    expect(msixFileName('zWorkTracker', msixVersion('1.3.2'), 'test')).toBe(TEST.file);
  });

  it('refuse a version the Store would turn away, and a package that is not one of the two', () => {
    expect(messageOf(() => msixFileName('zWorkTracker', '0.2.0', 'store'))).toContain('starts with 0');
    expect(messageOf(() => msixFileName('zWorkTracker', '1.3', 'test'))).toContain('is not a version the Store takes');
    expect(messageOf(() => msixFileName('zWorkTracker', '1.3.2', 'both'))).toContain('Unknown package');
  });

  it('differ from each other, so neither can overwrite the other', () => {
    expect(msixFileName('zWorkTracker', '1.3.2', 'store')).not.toBe(msixFileName('zWorkTracker', '1.3.2', 'test'));
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
      Version: '1.3.2.0',
      ProcessorArchitecture: 'x64',
    });
    expect(only(doc, NS.foundation, 'PublisherDisplayName').textContent).toBe(want.publisherDisplayName);
    expect(only(doc, NS.foundation, 'DisplayName').textContent).toBe('zWorkTracker');
  });

  it('of the Store package says the Store’s own values, as Partner Center prints them', () => {
    const xml = manifestFor('store', app);
    expect(xml).toContain('<Identity Name="PedroMiguelRodriguesJorge.zWorkTracker" Publisher="CN=1DEF8D7B-1D68-4604-8047-048DC92CF3A9" Version="1.3.2.0" ProcessorArchitecture="x64" />');
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

  it('names exactly the images the packaging script cuts, each at the base size of its kind', () => {
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
