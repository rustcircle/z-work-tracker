export const EXECUTABLE: string;
/** The file at the root of a package that Windows finds the qualified images through: resources.pri. */
export const RESOURCE_INDEX: string;
export const ASSETS: Readonly<Record<string, number>>;
export const TARGET_SIZES: readonly number[];
export const SCALES: readonly number[];
export const TARGET_FORMS: readonly string[];

/** One image of the packages: its path inside the package, with forward slashes, and the side in pixels it is cut to. */
export interface AssetImage {
  name: string;
  size: number;
}

/** What the header of a PNG file says. `alpha` is whether the image can be transparent. */
export interface PngInfo {
  width: number;
  height: number;
  alpha: boolean;
}

/** The packages one run makes from the same build. */
export type PackageKind = 'store' | 'test';

export interface PackageIdentity {
  name: string;
  publisher: string;
  publisherDisplayName: string;
}

export interface PackageSpec {
  /** Ends the file name, after the version and the architecture. */
  readonly suffix: string;
  readonly identity: Readonly<PackageIdentity>;
}

export interface ManifestFields extends PackageIdentity {
  displayName: string;
  description: string;
  version: string;
}

/** A prebuilt resources.pri found for a package: where it is, what it holds, and the variable that named it (null if it was the usual place). */
export interface ResourceIndex {
  file: string;
  bytes: Buffer;
  variable: string | null;
}

/** What `resourceIndexFor` needs besides the package: the environment, the repo, and the function that reads a file or says (null) there is none. */
export interface ResourceIndexLookup {
  env: Readonly<Record<string, string | undefined>>;
  root: string;
  read: (file: string) => Buffer | null;
}

export const PACKAGES: Readonly<Record<PackageKind, PackageSpec>>;

export function msixVersion(version: unknown): string;
export function parseArguments(argv: readonly string[]): { build: boolean; kinds: PackageKind[] };
export function retiredVariables(env: Record<string, string | undefined>): string[];
export function checkIdentity<T extends { name: unknown; publisher: unknown }>(identity: T): T;
export function identityOf(kind: unknown): PackageIdentity;
export function msixFileName(productName: string, version: unknown, kind: unknown): string;
export function encodePublisherHash(hash: Uint8Array): string;
export function publisherId(publisher: unknown): string;
export function packageFamilyName(name: unknown, publisher: unknown): string;
export function buildManifest(fields: ManifestFields): string;
export function manifestFor(kind: unknown, fields: { displayName: string; description: string; version: string }): string;
export function resourceCopies(resources: unknown, tauriDir: string): { from: string; to: string }[];
export function scaledSize(base: number, scale: number): number;
export function assetImages(): AssetImage[];
export function lackingAssets(entries: readonly string[]): string[];
/** How makepri writes the path of an image (such as `Assets/StoreLogo.png`) into a resources.pri: with backslashes. */
export function indexPathOf(name: string): string;
/** Whether a resources.pri holds the path of one image, as makepri writes a path, or in UTF-16LE. */
export function indexHoldsImage(bytes: Buffer, name: string): boolean;
/** The images of `assetImages` whose paths a resources.pri does not hold. */
export function imagesLackingInIndex(bytes: Buffer): string[];
/** Returns the bytes of a resources.pri that lists every image of `assetImages`, and throws what is wrong with one that does not. */
export function checkIndexImages(bytes: Buffer): Buffer;
export function resourceIndexVariable(kind: unknown): string;
export function checkResourceIndex(kind: unknown, bytes: Buffer): Buffer;
export function resourceIndexFor(kind: unknown, where: ResourceIndexLookup): ResourceIndex | null;
export function pngInfo(bytes: Buffer): PngInfo | null;
export function embeddedVersion(exe: Buffer): string | null;
