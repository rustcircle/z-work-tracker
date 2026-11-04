/** The tool macOS cuts the images with. */
export const SIPS: string;

/** What tauri.conf.json holds that the packaging scripts read. The rest of the file is there too. */
export interface AppConf {
  productName: string;
  version?: unknown;
  bundle?: { shortDescription?: string; resources?: unknown };
  [key: string]: unknown;
}

export function readAppConf(tauriDir: string): AppConf;
export function cargoTargetRoot(tauriDir: string, env: Readonly<Record<string, string | undefined>>): string;
/** Cuts every image of the packages from `icon` into `dir` and returns their names (Assets/...). */
export function cutAssetImages(where: { icon: string; dir: string; sips?: string }): string[];
