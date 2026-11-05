// @vitest-environment node
// recompressPng, which writes the images of the packages again smaller with the same pixels, and cutAssetImages, which must keep every
// image under the 200 KB that the Windows App Certification Kit allows. The second needs sips, so it runs on a Mac only.
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { crc32, deflateSync, inflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';

import { assetImages, pngInfo } from './msix-manifest.mjs';
import { MAX_ASSET_BYTES, cutAssetImages, recompressPng } from './msix-stage.mjs';

const root = resolve(import.meta.dirname, '..');
const SIGNATURE = Buffer.from('89504e470d0a1a0a', 'hex');

function chunk(type: string, data: Buffer): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, 'latin1');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
  return Buffer.concat([head, data, crc]);
}

/** A PNG of `width` by `height` pixels with no filter and no compression, as large as a PNG of it can be, plus a text chunk. */
function loosePng(width: number, height: number, colourType: number, pixel: (x: number, y: number) => number[]): Buffer {
  const channels = colourType === 6 ? 4 : 3;
  const rows: number[] = [];
  for (let y = 0; y < height; y++) {
    rows.push(0);
    for (let x = 0; x < width; x++) rows.push(...pixel(x, y).slice(0, channels));
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = colourType;
  return Buffer.concat([SIGNATURE, chunk('IHDR', header), chunk('tEXt', Buffer.from('Comment\0stand-in')), chunk('IDAT', deflateSync(Buffer.from(rows), { level: 0 })), chunk('IEND', Buffer.alloc(0))]);
}

/** The RGBA pixels of an 8-bit RGBA PNG, decoded here on its own so that a fault in the module is not repeated by the test. */
function pixelsOf(png: Buffer): Buffer {
  let width = 0, height = 0;
  const data: Buffer[] = [];
  for (let at = 8; at < png.length; ) {
    const length = png.readUInt32BE(at);
    const type = png.toString('latin1', at + 4, at + 8);
    if (type === 'IHDR') [width, height] = [png.readUInt32BE(at + 8), png.readUInt32BE(at + 12)];
    if (type === 'IDAT') data.push(png.subarray(at + 8, at + 8 + length));
    at += 12 + length;
  }
  const raw = inflateSync(Buffer.concat(data));
  const stride = width * 4;
  const out = Buffer.alloc(height * stride);
  for (let y = 0; y < height; y++) {
    const filter = raw.readUInt8(y * (stride + 1));
    for (let x = 0; x < stride; x++) {
      const a = x >= 4 ? out.readUInt8(y * stride + x - 4) : 0;
      const b = y > 0 ? out.readUInt8((y - 1) * stride + x) : 0;
      const c = x >= 4 && y > 0 ? out.readUInt8((y - 1) * stride + x - 4) : 0;
      const p = a + b - c;
      const paeth = Math.abs(p - a) <= Math.abs(p - b) && Math.abs(p - a) <= Math.abs(p - c) ? a : Math.abs(p - b) <= Math.abs(p - c) ? b : c;
      const guess = [0, a, b, (a + b) >> 1, paeth][filter] ?? 0;
      out[y * stride + x] = (raw.readUInt8(y * (stride + 1) + 1 + x) + guess) & 255;
    }
  }
  return out;
}

describe('recompressPng', () => {
  // A soft gradient with a transparent corner, the kind of picture an app icon is.
  const gradient = (x: number, y: number) => [x * 2, y * 2, (x + y) % 256, x + y < 40 ? 0 : 255];

  it('writes an RGBA image again smaller, with every pixel the same and only the header, the pixels and the end', () => {
    const before = loosePng(120, 90, 6, gradient);
    const after = recompressPng(before);
    expect(after.length).toBeLessThan(before.length / 4);
    expect(pngInfo(after)).toEqual({ width: 120, height: 90, alpha: true });
    expect(pixelsOf(after).equals(pixelsOf(before))).toBe(true);
    expect(after.includes(Buffer.from('tEXt'))).toBe(false);
  });

  it('gives back as they are a PNG that is not 8-bit RGBA, and bytes that are not a PNG', () => {
    const rgb = loosePng(20, 20, 2, gradient);
    expect(recompressPng(rgb)).toBe(rgb);
    const text = Buffer.from('not a picture');
    expect(recompressPng(text)).toBe(text);
  });

  it('gives back an image it cannot make smaller as it is', () => {
    const once = recompressPng(loosePng(64, 64, 6, gradient));
    expect(recompressPng(once)).toBe(once);
  });
});

describe.skipIf(!(process.platform === 'darwin' && existsSync('/usr/bin/sips')))('cutAssetImages, with sips', () => {
  it('cuts every image from the app icon under the 200 KB that WACK allows, the 600 px tile included', () => {
    const dir = mkdtempSync(join(tmpdir(), 'zwt-msix-stage-'));
    try {
      cutAssetImages({ icon: join(root, 'src-tauri', 'icons', 'icon.png'), dir });
      for (const { name, size } of assetImages()) {
        const file = join(dir, name);
        expect(statSync(file).size, name).toBeLessThan(MAX_ASSET_BYTES);
        expect(pngInfo(readFileSync(file)), name).toEqual({ width: size, height: size, alpha: true });
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);
});
