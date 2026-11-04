import type { PackageKind } from './msix-manifest.mjs';

export const DEFAULT_HOST: string;
export const DEFAULT_PORT: number;
export const DEFAULT_TIMEOUT_MINUTES: number;
/** The most a PUT may carry, in bytes. */
export const UPLOAD_LIMIT: number;
/** How long the server keeps a connection with nothing to do open, in milliseconds: longer than the 100 seconds Windows PowerShell 5.1 reuses one for. */
export const KEEP_ALIVE_MS: number;
/** The only folder the script on the VM writes in. */
export const VM_DIRECTORY: string;
/** The script the VM fetches. */
export const SCRIPT_PATH: string;
/** Where each package's index is PUT: the only two names the server takes a PUT for. */
export const UPLOAD_PATHS: Readonly<Record<PackageKind, string>>;
/** Where the VM asks what the Mac holds already and how the job stands: a small JSON built when it is asked. */
export const STATUS_PATH: string;
/** Where the VM fetches makepri.exe from: the x64 one on every PC, and the arm64 one only if the x64 one does not start (the PC's architecture is not asked). */
export const TOOL_PATHS: Readonly<Record<Architecture, string>>;
export const PACKAGE_ID: string;
export const VERSIONS_URL: string;

export type Architecture = 'arm64' | 'x64';

/** An expected failure: what went wrong, said once, with no stack. */
export class Failure extends Error {}

export interface Options {
  help: boolean;
  dryRun: boolean;
  host: string;
  port: number;
  timeoutMinutes: number;
  outDir: string | null;
  toolsDir: string | null;
  sdkVersion: string | null;
  dotnet: string | null;
}

export function helpText(): string;
/**
 * The command line. `extra` lets another script share it: `timeoutMinutes` is its default wait, and `paths` maps more options that take a folder to the key
 * they are returned under (null when not given).
 */
export function parseOptions<P extends string = never>(
  argv: readonly string[],
  extra?: { timeoutMinutes?: number; paths?: Readonly<Record<string, P>> },
): Options & { [K in P]: string | null };
export function vmLine(host: string, port: number): string;
export function addressIsUp(host: string, interfaces?: Readonly<Record<string, readonly { address: string }[] | undefined>>): boolean;
export function listenProblem(error: unknown, host: string, port: number): string;
/** Checks that the address is the Mac's and the port is free; a Failure says which is not. Nothing is stopped or killed to make room. */
export function checkCanListen(host: string, port: number): Promise<void>;

/** What the functions that fetch are given in place of `fetch`: a function of an address, which tests replace. */
export type Fetcher = (input: string, init?: RequestInit) => Promise<Response>;

export function compareVersions(a: string, b: string): number;
export function latestStable(versions: readonly unknown[]): string;
export function packageUrl(version: string): string;
export function isNugetUrl(text: string): boolean;
export function fetchFromNuget(start: string, options?: { signal?: AbortSignal; fetchImpl?: Fetcher }): Promise<{ response: Response; url: string }>;
export function downloadFile(
  url: string,
  file: string,
  options?: { signal?: AbortSignal; fetchImpl?: Fetcher; maxBytes?: number; onProgress?: (bytes: number, total: number) => void },
): Promise<{ bytes: number; sha256: string }>;
export function peMachine(bytes: Buffer): string | null;
export function findMakepriMembers(entries: readonly string[]): { sdk: string; arm64: string; x64: string };

/** A signature that `dotnet nuget verify --all` lists: its type (Author, Repository) and the subject name of its certificate. */
export interface Signature {
  type: string;
  subject: string;
}
export function signaturesIn(output: string): Signature[];
export function signerProblem(signatures: readonly Signature[]): string | null;

/** One file kept in the folder of an SDK version, by name, with its size and SHA-256. */
export interface KeptFile {
  file: string;
  bytes: number;
  sha256: string;
}

/** The cache.json of an SDK version's folder. */
export interface ToolCacheRecord {
  schema: 1;
  package: string;
  version: string;
  sdk: string;
  source: string;
  nupkg: KeptFile;
  verified: { command: string; dotnet: string; line: string; at: string };
  makepri: Record<Architecture, KeptFile & { member: string; machine: string }>;
}

export function readToolCache(dir: string, version: string): { record: ToolCacheRecord; reason?: undefined } | { record?: undefined; reason: string };

export interface Makepri {
  version: string;
  dir: string;
  /** True if nothing was fetched: the folder already held a good copy. */
  reused: boolean;
  record: ToolCacheRecord;
  tools: Record<Architecture, KeptFile>;
}

export function ensureMakepri(options: {
  toolsDir: string;
  sdkVersion?: string | null;
  dotnet?: string | null;
  env?: Readonly<Record<string, string | undefined>>;
  say?: (line: string) => void;
  signal?: AbortSignal;
  fetchImpl?: Fetcher;
}): Promise<Makepri>;

export interface FolderFile {
  path: string;
  bytes: Buffer;
  sha256: string;
}

export function folderFiles(): string[];
export function stageFolders(options: { outDir: string; icon: string; productName: string; description: string; version: string; sips?: string }): void;
export function readFolders(outDir: string): Record<PackageKind, FolderFile[]>;

/** One thing the server serves: its bytes (or a function that makes them when they are asked for) and Content-Type. */
export interface Served {
  body: Buffer | (() => Buffer);
  type: string;
}

export function scriptRoute(script: string): Served;
/** A route that answers with JSON built when it is asked, from `state()`. */
export function jsonRoute(state: () => unknown): Served;
/** What the Mac holds of the two indexes, as /status says it: for each package null, or the size and SHA-256 of what was kept. */
export function priStatus(received: Partial<Record<PackageKind, Buffer>>): Record<PackageKind, { bytes: number; sha256: string } | null>;
export function buildRoutes(parts: { folders: Record<PackageKind, readonly { path: string; bytes: Buffer }[]>; tools: Record<Architecture, { bytes: Buffer }> }): Map<string, Served>;

/** What both scripts for the VM are told: where the Mac serves, the line typed, the SHA-256 of what is fetched, and the images the dump of an index must list. */
export interface VmScriptSpec {
  baseUrl: string;
  line: string;
  tools: Record<Architecture, string>;
  files: Record<PackageKind, readonly { path: string; sha256: string }[]>;
  unplated: readonly string[];
}

export function buildVmScript(spec: VmScriptSpec): string;
/** The sections the script is built from, for msix-vm.mjs to build its own from. */
export const VM_SECTIONS: Readonly<{ head: string; helpers: string; indexStep: string }>;
export const SHA256: RegExp;
export const PLAIN: RegExp;
export const PLAIN_ROOT: RegExp;
export const PLAIN_LINE: RegExp;
/** `text` if it is plain enough to sit in a single-quoted PowerShell string, else a throw. */
export function plain(text: unknown, what: string, pattern?: RegExp): string;
/** Fills the @@NAME@@ places of `template`; a place nothing fills, one left over, or a character that is not plain ASCII is an error. */
export function fillScript(template: string, fill: Readonly<Record<string, string>>): string;
/** The places of VM_SECTIONS.head that both scripts fill. */
export function scriptFills(spec: VmScriptSpec & { what: string; scope: string }): Record<string, string>;
export function unplatedNames(): string[];

export function indexProblem(kind: PackageKind, bytes: Buffer): string | null;

/** One request the server answered. `error` is set, with status 0, for an error of the server itself; `detail` is why an upload was refused. */
export interface RequestEvent {
  method: string;
  path: string;
  status: number;
  bytes: number;
  client: string;
  error?: string;
  detail?: string;
}

export type StopReason = 'complete' | 'timeout' | 'interrupted' | 'failed';

/** What the server takes for one kind of upload, over the defaults. */
export interface UploadRule<K extends string = PackageKind> {
  /** The most bytes taken. */
  limit?: number;
  /** Returns null, or why the bytes are refused (422). */
  validate?: (kind: K, bytes: Buffer) => string | null;
  /** Each upload that passes replaces the one before, instead of the first being kept. */
  replace?: boolean;
}

export interface ServerOutcome<K extends string = PackageKind> {
  reason: StopReason;
  received: Partial<Record<K, Buffer>>;
  /** For a kind, the last upload that was refused and why: the VM may not manage to show the reason. */
  refused: Partial<Record<K, { problem: string; bytes: Buffer }>>;
}

export interface ServerOptions<K extends string = PackageKind> {
  host: string;
  port: number;
  routes: ReadonlyMap<string, Served>;
  uploads?: Readonly<Record<K, string>>;
  rules?: Partial<Record<K, UploadRule<K>>>;
  limit?: number;
  validate?: (kind: K, bytes: Buffer) => string | null;
  /** Says, after an upload was kept, whether the server is done (default: every kind has one). */
  isComplete?: (received: ReadonlyMap<K, Buffer>) => boolean;
  /** A path that is served: an upload is taken only from an address that has fetched it. */
  peerGate?: string | null;
  keepAliveMs?: number;
  timeoutMs: number;
  signal?: AbortSignal;
  observe?: (event: RequestEvent) => void;
  /** Told of every upload that was kept, after it was stored and before the answer is sent. */
  onAccepted?: (kind: K, bytes: Buffer, info: { replaced: boolean }) => void;
}

export interface RunningServer<K extends string = PackageKind> {
  host: string;
  port: number;
  finished: Promise<ServerOutcome<K>>;
  stop: (reason?: StopReason) => void;
  /** What the server holds now, and the addresses that have fetched the path of the gate. */
  snapshot: () => { received: Partial<Record<K, Buffer>>; refused: Partial<Record<K, { problem: string; bytes: Buffer }>>; fetchers: string[] };
}

export function startServer<K extends string = PackageKind>(options: ServerOptions<K>): Promise<RunningServer<K>>;

/** One request to the server, with node:http so that the path goes out exactly as written. */
export function exchange(
  where: { host: string; port: number },
  request: { method?: string; path: string; headers?: Record<string, string>; body?: Buffer | string },
): Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: Buffer }>;

/** `text` as one line, cut to `max` characters, with every control character shown as a space. */
export function oneLine(text: unknown, max?: number): string;
/** The line a request is shown as while the VM works, with the reason of a refusal under it. */
export function progressPrinter(say: (line: string) => void, folders: Record<PackageKind, readonly unknown[]>): (event: RequestEvent) => undefined;

export function sampleIndex(kind: PackageKind): Buffer;

export interface InstallResult {
  installed: { kind: PackageKind; file: string; bytes: number; sha256: string; replaced: string | null }[];
  problems: { kind: PackageKind; message: string }[];
  missing: PackageKind[];
}

export function installIndexes(received: Partial<Record<PackageKind, Buffer>>, where: { root: string }): InstallResult;

export function run(
  argv: readonly string[],
  context?: { env?: Readonly<Record<string, string | undefined>>; say?: (line: string) => void; root?: string; signal?: AbortSignal },
): Promise<number>;
