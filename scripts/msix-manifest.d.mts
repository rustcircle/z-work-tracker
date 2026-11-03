export const EXECUTABLE: string;
export const ASSETS: Readonly<Record<string, number>>;

export interface StoreIdentity {
  name: string;
  publisher: string;
  publisherDisplayName: string;
}

export interface ManifestFields extends StoreIdentity {
  displayName: string;
  description: string;
  version: string;
}

export function msixVersion(version: unknown): string;
export function readIdentity(env: Record<string, string | undefined>): StoreIdentity;
export function buildManifest(fields: ManifestFields): string;
export function resourceCopies(resources: unknown, tauriDir: string): { from: string; to: string }[];
export function embeddedVersion(exe: Buffer): string | null;
