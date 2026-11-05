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
/** WACK fails any image in a package of this many bytes (200 KB) or more. */
export const MAX_ASSET_BYTES: number;
/** The same PNG with the same pixels, written smaller (8-bit RGBA only); anything else, or what it cannot shrink, comes back as it is. */
export function recompressPng(bytes: Buffer): Buffer;
