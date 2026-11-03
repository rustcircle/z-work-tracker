export const EXECUTABLE: string;
export const ASSETS: Readonly<Record<string, number>>;

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
export function embeddedVersion(exe: Buffer): string | null;
