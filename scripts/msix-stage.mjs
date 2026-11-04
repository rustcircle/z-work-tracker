// The staging that package-msix.mjs and make-pri.mjs share: what is read from src-tauri/tauri.conf.json, where Cargo puts its build, and the
// images of the packages cut from the app icon with sips. These touch files and run a tool, so they are not in msix-manifest.mjs, which is all values.
// package-msix.mjs is a script that runs when it is imported, so nothing it does can be shared from there.
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

import { assetImages, pngInfo } from './msix-manifest.mjs';

/** The tool macOS cuts the images with. */
export const SIPS = '/usr/bin/sips';

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
 * once, and the other images of that size are copies. Whatever is wrong throws, saying what: no icon, one that is not a PNG or not transparent,
 * a cut that sips failed or that did not come out the size asked with transparency.
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
      const info = pngInfo(readFileSync(file));
      if (!info || info.width !== size || info.height !== size || !info.alpha) {
        throw new Error(`sips cut ${name} as ${info ? `${info.width} by ${info.height} pixels ${info.alpha ? 'with' : 'without'} transparency` : 'something that is not a PNG file'}, and it must be ${size} by ${size} pixels with transparency.`);
      }
      cutAt.set(size, file);
    }
    cut.push(name);
  }
  return cut;
}
