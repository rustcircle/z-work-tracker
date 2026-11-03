// @vitest-environment jsdom
// jsdom for DOMParser: the manifest is read back as XML, so what is checked is what a reader of the package would see.
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { ASSETS, buildManifest, embeddedVersion, msixVersion, readIdentity, resourceCopies } from './msix-manifest.mjs';

const NS = {
  foundation: 'http://schemas.microsoft.com/appx/manifest/foundation/windows10',
  uap: 'http://schemas.microsoft.com/appx/manifest/uap/windows10',
  rescap: 'http://schemas.microsoft.com/appx/manifest/foundation/windows10/restrictedcapabilities',
  desktop: 'http://schemas.microsoft.com/appx/manifest/desktop/windows10',
};

/** The values Partner Center would issue, made up. */
const issued = {
  ZWT_STORE_IDENTITY_NAME: 'Placeholder.zWorkTracker',
  ZWT_STORE_PUBLISHER: 'CN=00000000-0000-0000-0000-000000000000',
  ZWT_STORE_PUBLISHER_DISPLAY_NAME: 'Pedro Jorge',
};

const fields = {
  name: 'Placeholder.zWorkTracker',
  publisher: 'CN=00000000-0000-0000-0000-000000000000',
  publisherDisplayName: 'Pedro Jorge',
  displayName: 'zWorkTracker',
  description: 'Labor hours tracker',
  version: '1.3.0',
};

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

describe('the Store identity', () => {
  it('reads the three values Partner Center issues', () => {
    expect(readIdentity(issued)).toEqual({
      name: 'Placeholder.zWorkTracker',
      publisher: 'CN=00000000-0000-0000-0000-000000000000',
      publisherDisplayName: 'Pedro Jorge',
    });
  });

  it('ignores other variables and removes spaces left by copying', () => {
    const copied = { ...issued, ZWT_STORE_IDENTITY_NAME: '  Placeholder.zWorkTracker\n', ZWT_STORE_PUBLISHER_DISPLAY_NAME: ' Pedro Jorge ', PATH: '/usr/bin' };
    expect(readIdentity(copied)).toEqual(readIdentity(issued));
  });

  it('has no defaults: with nothing set it names all three, and where to look', () => {
    const message = messageOf(() => readIdentity({}));
    for (const name of ['ZWT_STORE_IDENTITY_NAME', 'ZWT_STORE_PUBLISHER ', 'ZWT_STORE_PUBLISHER_DISPLAY_NAME']) expect(message).toContain(name);
    expect(message).toContain('Product management > Product identity');
  });

  it('names only what is missing', () => {
    const message = messageOf(() => readIdentity({ ...issued, ZWT_STORE_PUBLISHER_DISPLAY_NAME: undefined }));
    expect(message).toContain('ZWT_STORE_PUBLISHER_DISPLAY_NAME');
    expect(message).not.toContain('ZWT_STORE_IDENTITY_NAME');
    expect(message).not.toMatch(/ZWT_STORE_PUBLISHER\b/);
  });

  it('counts a blank value as missing', () => {
    const message = messageOf(() => readIdentity({ ...issued, ZWT_STORE_PUBLISHER: '', ZWT_STORE_IDENTITY_NAME: '   ' }));
    expect(message).toContain('ZWT_STORE_IDENTITY_NAME');
    expect(message).toMatch(/ZWT_STORE_PUBLISHER\b/);
    expect(message).not.toContain('ZWT_STORE_PUBLISHER_DISPLAY_NAME');
  });

  it('wants a publisher that starts with CN=', () => {
    for (const publisher of ['Pedro Jorge', 'cn=00000000-0000-0000-0000-000000000000', '00000000-0000-0000-0000-000000000000']) {
      expect(messageOf(() => readIdentity({ ...issued, ZWT_STORE_PUBLISHER: publisher })), publisher).toContain('starts with CN=');
    }
  });

  it('refuses a name the Store would turn away, and takes the ones it issues', () => {
    for (const name of ['ab', 'has space', 'under_score', 'Pedro&Co.App', 'x'.repeat(51)]) {
      expect(messageOf(() => readIdentity({ ...issued, ZWT_STORE_IDENTITY_NAME: name })), name).toContain('ZWT_STORE_IDENTITY_NAME must be');
    }
    for (const name of ['12345PedroJorge.zWorkTracker', 'a-b.c', 'x'.repeat(50)]) {
      expect(readIdentity({ ...issued, ZWT_STORE_IDENTITY_NAME: name }).name).toBe(name);
    }
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
    expect(only(doc, NS.foundation, 'PublisherDisplayName').textContent).toBe('Pedro Jorge');
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
