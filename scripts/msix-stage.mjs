// The staging that package-msix.mjs and make-pri.mjs share: what is read from src-tauri/tauri.conf.json, where Cargo puts its build, and the
// images of the packages cut from the app icon with sips. These touch files and run a tool, so they are not in msix-manifest.mjs, which is all values.
// package-msix.mjs is a script that runs when it is imported, so nothing it does can be shared from there.
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { crc32, deflateSync, inflateSync } from 'node:zlib';

import { assetImages, pngInfo } from './msix-manifest.mjs';

/** The tool macOS cuts the images with. */
export const SIPS = '/usr/bin/sips';
/**
 * The Windows App Certification Kit's "App resources" test fails any image in a package of this many bytes (200 KB) or more, and also
 * one whose side is not the one its name asks for. sips wrote the 600 px Square150x150Logo.scale-400.png at 214,745 bytes, which 1.4.0's
 * first WACK run failed; cut at 512 px it failed for the side instead. recompressPng writes it at 600 px in about 150 KB.
 */
export const MAX_ASSET_BYTES = 204_800;

const PNG_SIGNATURE = Buffer.from('89504e470d0a1a0a', 'hex');

function pngChunk(type, data) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, 'latin1');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
  return Buffer.concat([head, data, crc]);
}

/** What PNG filter `filter` predicts a byte to be from the byte to its left (a), above (b) and above-left (c). */
function predict(filter, a, b, c) {
  if (filter === 1) return a;
  if (filter === 2) return b;
  if (filter === 3) return (a + b) >> 1;
  if (filter === 4) {
    const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
    return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
  }
  return 0;
}

/**
 * The same image as `bytes`, a PNG, written again with its pixels untouched and zlib at level 9: once with no filter and once with the
 * filter that suits each row best, whichever is smaller. Only the header, the pixels and the end are kept (sips adds a colour profile and
 * other chunks a tile has no use for). It reads 8-bit RGBA without interlacing, which is what sips writes; any other PNG is given back
 * as it is, and so is one that this does not make smaller.
 */
export function recompressPng(bytes) {
  if (bytes.length < 33 || !bytes.subarray(0, 8).equals(PNG_SIGNATURE)) return bytes;
  let header;
  const data = [];
  for (let at = 8; at + 12 <= bytes.length; ) {
    const length = bytes.readUInt32BE(at);
    const type = bytes.toString('latin1', at + 4, at + 8);
    if (type === 'IHDR') header = bytes.subarray(at + 8, at + 8 + length);
    if (type === 'IDAT') data.push(bytes.subarray(at + 8, at + 8 + length));
    at += 12 + length;
  }
  if (!header || header.length !== 13 || header[8] !== 8 || header[9] !== 6 || header[12] !== 0 || data.length === 0) return bytes;
  const width = header.readUInt32BE(0), height = header.readUInt32BE(4), bpp = 4, stride = width * bpp;
  let raw;
  try {
    raw = inflateSync(Buffer.concat(data));
  } catch {
    return bytes;
  }
  if (raw.length !== height * (stride + 1)) return bytes;
  const px = Buffer.alloc(height * stride);
  const left = (x, y) => (x >= bpp ? px[y * stride + x - bpp] : 0);
  const up = (x, y) => (y > 0 ? px[(y - 1) * stride + x] : 0);
  const upLeft = (x, y) => (x >= bpp && y > 0 ? px[(y - 1) * stride + x - bpp] : 0);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    if (filter > 4) return bytes;
    for (let x = 0; x < stride; x++) {
      px[y * stride + x] = (raw[y * (stride + 1) + 1 + x] + predict(filter, left(x, y), up(x, y), upLeft(x, y))) & 255;
    }
  }
  const encode = (filters) => {
    const out = Buffer.alloc(height * (stride + 1));
    for (let y = 0; y < height; y++) {
      let best = 0, bestCost = Infinity;
      for (const filter of filters) {
        let cost = 0;
        for (let x = 0; x < stride; x++) {
          const v = (px[y * stride + x] - predict(filter, left(x, y), up(x, y), upLeft(x, y))) & 255;
          cost += v < 128 ? v : 256 - v;
        }
        if (cost < bestCost) [best, bestCost] = [filter, cost];
      }
      out[y * (stride + 1)] = best;
      for (let x = 0; x < stride; x++) {
        out[y * (stride + 1) + 1 + x] = (px[y * stride + x] - predict(best, left(x, y), up(x, y), upLeft(x, y))) & 255;
      }
    }
    return deflateSync(out, { level: 9, memLevel: 9 });
  };
  const packed = [encode([0]), encode([0, 1, 2, 3, 4])].sort((p, q) => p.length - q.length)[0];
  const result = Buffer.concat([PNG_SIGNATURE, pngChunk('IHDR', header), pngChunk('IDAT', packed), pngChunk('IEND', Buffer.alloc(0))]);
  return result.length < bytes.length ? result : bytes;
}

/**
 * tauri.conf.json, read from the `tauriDir` folder: the whole config, once it is known to name the app (productName) and describe it
 * (bundle.shortDescription), which the manifest of a package needs. Anything else that is wrong with it throws what JSON.parse does.
 */
export function readAppConf(tauriDir) {
  const conf = JSON.parse(readFileSync(join(tauriDir, 'tauri.conf.json'), 'utf8'));
  const unnamed = [['productName', conf.productName], ['bundle.shortDescription', conf.bundle?.shortDescription]].filter(([, value]) => typeof value !== 'string' || !value);
  if (unnamed.length > 0) throw new Error(`src-tauri/tauri.conf.json needs ${unnamed.map(([key]) => key).join(' and ')}.`);
  return conf;
}

/**
 * The folder Cargo builds in. Cargo reads a relative CARGO_TARGET_DIR against the folder it runs in, which here is `tauriDir`. The same
 * rule as package-windows.mjs.
 */
export function cargoTargetRoot(tauriDir, env) {
  return env.CARGO_TARGET_DIR ? resolve(tauriDir, env.CARGO_TARGET_DIR) : join(tauriDir, 'target');
}

/**
 * Cuts every image of assetImages() from the app icon `icon` into `dir`, at the path its name gives (Assets/...), and returns those names. The
 * app icon is transparent, and so must be every image cut from it: an image with no alpha channel is drawn as a solid square. Each size is cut
 * once, written again smaller by recompressPng, and the other images of that size are copies. Whatever is wrong throws, saying what: no icon, one that is not a PNG or not transparent,
 * a cut that sips failed, that did not come out the size asked with transparency, or that is MAX_ASSET_BYTES or more.
 */
export function cutAssetImages({ icon, dir, sips = SIPS }) {
  if (!existsSync(icon)) throw new Error(`The app icon is missing: ${icon}`);
  const iconInfo = pngInfo(readFileSync(icon));
  if (!iconInfo) throw new Error(`The app icon is not a PNG file: ${icon}`);
  if (!iconInfo.alpha) throw new Error(`The app icon has no transparency: ${icon}. The logo and the tiles are cut from it, and would be drawn as solid squares.`);
  const cutAt = new Map();
  const cut = [];
  for (const { name, size } of assetImages()) {
    const file = join(dir, name);
    mkdirSync(dirname(file), { recursive: true });
    const done = cutAt.get(size);
    if (done) {
      copyFileSync(done, file);
    } else {
      const run = spawnSync(sips, ['-s', 'format', 'png', '-z', String(size), String(size), icon, '--out', file], { encoding: 'utf8' });
      if (run.status !== 0 || !existsSync(file)) throw new Error(`sips could not cut ${name} from ${icon}:\n${run.stdout}${run.stderr}`.trim());
      const bytes = recompressPng(readFileSync(file));
      writeFileSync(file, bytes);
      if (bytes.length >= MAX_ASSET_BYTES) {
        throw new Error(`sips cut ${name} as ${bytes.length} bytes, and the Windows App Certification Kit fails any image of ${MAX_ASSET_BYTES} bytes or more.`);
      }
      const info = pngInfo(bytes);
      if (!info || info.width !== size || info.height !== size || !info.alpha) {
        throw new Error(`sips cut ${name} as ${info ? `${info.width} by ${info.height} pixels ${info.alpha ? 'with' : 'without'} transparency` : 'something that is not a PNG file'}, and it must be ${size} by ${size} pixels with transparency.`);
      }
      cutAt.set(size, file);
    }
    cut.push(name);
  }
  return cut;
}
