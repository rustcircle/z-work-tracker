// Names the installer a Windows build just produced. Tauri writes <productName>_<version>_x64-setup.exe and leaves the
// installers of earlier versions in the same folder, so taking the first "-setup.exe" found can report on a stale one.
import { existsSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Returns { path } of this version's x64 NSIS installer in nsisDir, or { error }. Only the exact name from the Tauri
 * config counts: an older installer beside it is never used in its place.
 */
export function findInstaller(nsisDir, conf) {
  const { productName, version } = conf;
  if (typeof productName !== 'string' || !productName || typeof version !== 'string' || !version) {
    return { error: 'src-tauri/tauri.conf.json needs a productName and a version, which name the installer.' };
  }
  const path = join(nsisDir, `${productName}_${version}_x64-setup.exe`);
  return existsSync(path) ? { path } : { error: `No installer was produced: expected ${path}` };
}
