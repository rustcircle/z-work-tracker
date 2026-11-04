import type { Options, VmScriptSpec } from './make-pri.mjs';
import type { PackageKind } from './msix-manifest.mjs';

export { Failure } from './make-pri.mjs';

/** The most the whole job may take, in minutes. */
export const DEFAULT_TIMEOUT_MINUTES: number;
/** Where the VM sends the XML report of the certification kit, and the largest it may be. */
export const REPORT_PATH: string;
export const REPORT_LIMIT: number;
/** Where the VM tells the Mac what it is doing, and the largest one may be. A PUT here replaces the one before. */
export const VM_STATUS_PATH: string;
export const VM_STATUS_LIMIT: number;
/** The only four names the server takes a PUT for. */
export const VM_UPLOAD_PATHS: Readonly<{ store: string; test: string; report: string; status: string }>;
/** The folder the server serves the WACK copy, its certificate and the signed test package from. */
export const SERVED_DIRECTORY: string;
/** Microsoft's link to the installer of the current Windows SDK. */
export const SDK_INSTALLER_URL: string;
/** The feature of the SDK installer that holds the Windows App Certification Kit. */
export const SDK_FEATURE: string;
/** The package family names the gate holds the packages to. */
export const EXPECTED_FAMILY: Readonly<Record<PackageKind, string>>;
export const KEY_BITS: number;
export const WACK_VALID_DAYS: number;
export const WACK_SKEW_MINUTES: number;
export const VM_POLL_MINUTES: number;
export const VM_SDK_MINUTES: number;
export const VM_WACK_MINUTES: number;
/** After the report, how long the Mac waits for the VM to say it has finished, in minutes. */
export interface Linger {
  afterReport: number;
  afterReportWithTestPackage: number;
  afterFailure: number;
}
export const LINGER_MINUTES: Readonly<Linger>;

export function helpText(): string;

export type MsixVmOptions = Options & { publishDir: string | null; priDir: string | null };
export function parseOptions(argv: readonly string[]): MsixVmOptions;

/** A tool that was found: where, and which version it says it is. */
export interface FoundTool {
  path: string;
  version: string;
}
type Env = Readonly<Record<string, string | undefined>>;
export function findOpenssl(env?: Env): FoundTool;
export function findOsslsigncode(env?: Env): FoundTool;

export function packageEntries(file: string): string[];
export function packageEntry(file: string, entry: string): Buffer | null;
export interface ManifestIdentity {
  name: string | undefined;
  publisher: string | undefined;
  publisherDisplayName: string | undefined;
  version: string | undefined;
  architecture: string | undefined;
}
export function manifestIdentity(manifest: string): ManifestIdentity;
export function packagePublisher(file: string): string;

export function asn1Time(date: Date): string;
export interface CertificateSpec {
  readonly subject: string;
  readonly keyBits: number;
  readonly days: number;
  readonly notBefore: Date;
  readonly notAfter: Date;
  readonly extensions: Readonly<{ basicConstraints: string; keyUsage: string; extendedKeyUsage: string; subjectKeyIdentifier: string }>;
  readonly config: string;
}
export function certificateSpec(input: { subject: string; now?: Date; days?: number; skewMinutes?: number; keyBits?: number }): CertificateSpec;
export function opensslArguments(spec: CertificateSpec, files: { configFile: string; keyFile: string; certFile: string }): string[];
export interface CertificateFacts {
  subject: string;
  notBefore: string;
  notAfter: string;
  thumbprint: string;
  sha256: string;
  serial: string;
  keyBits: number | undefined;
  keyUsage: string;
  extendedKeyUsage: string;
  basicConstraints: string;
  signatureAlgorithm: string;
}
export function createWackCertificate(options: { openssl: FoundTool; dir: string; spec: CertificateSpec }): { keyFile: string; certFile: string; pem: string; facts: CertificateFacts };
export function certificateFacts(pem: string, spec: CertificateSpec, openssl: FoundTool, certFile: string): CertificateFacts;
export function verifiedOk(status: number | null, text: string): boolean;
/** The digest algorithm osslsigncode verify names, or null. */
export function digestOf(text: string): string | null;

export interface WackCopy {
  signedFile: string;
  certificateFile: string;
  certificate: CertificateFacts & { derSha256: string; derBytes: number };
  signedSha256: string;
  signedBytes: number;
  unsignedSha256: { before: string; after: string };
  verified: string;
  keyDir: string;
  keyRemoved: boolean;
  tools: { openssl: string; osslsigncode: string };
}
export function signWackCopy(options: { storePackage: string; outDir: string; now?: Date; env?: Env; say?: (line: string) => void; tools?: { openssl: FoundTool; osslsigncode: FoundTool } | null }): WackCopy;

export type TestCopy =
  | { skipped: string; signedFile?: undefined }
  | { skipped?: undefined; signedFile: string; signedSha256: string; signedBytes: number; signerThumbprint: string; signerSubject: string; notAfter: string; verified: string };
export function signTestCopy(options: { testPackage: string; outDir: string; env?: Env; say?: (line: string) => void; tools?: { openssl: FoundTool; osslsigncode: FoundTool } | null }): TestCopy;

/** Anything in a folder that could be key material: a PEM private key, a .pfx, .p12 or .key file. */
export function keyMaterialIn(dir: string): string[];

export interface XmlElement {
  name: string;
  attrs: Record<string, string>;
  children: XmlElement[];
  text: string;
}
export function parseXml(text: string, limits?: { maxNodes?: number; maxDepth?: number }): XmlElement;
export function decodeXmlBytes(bytes: Buffer): string;

export type TestOutcome = 'PASS' | 'FAIL' | 'WARN' | 'UNKNOWN';
export function testOutcome(result: unknown, optional: boolean): TestOutcome;
export interface WackTest {
  index: string;
  name: string;
  description: string;
  executionTime: string;
  optional: boolean;
  rawResult: string;
  outcome: TestOutcome;
  messages: string[];
}
export interface WackRequirement {
  number: string;
  title: string;
  tests: WackTest[];
}
export interface WackReport {
  attributes: Record<string, string>;
  overall: string | null;
  requirements: WackRequirement[];
  tests: WackTest[];
  counts: Record<TestOutcome, number>;
  problems: string[];
  /** PARTIAL_RUN is TRUE: not every test was run. */
  partial: boolean;
}
export function parseWackReport(input: Buffer | string): WackReport;
export function reportPasses(report: WackReport): boolean;
export function formatWackReport(report: WackReport, options?: { maxMessages?: number; maxLength?: number }): string[];
export function reportSummary(report: WackReport, meta: { file: string; sha256: string; bytes: number }): Record<string, unknown>;
export function sampleWackReport(options?: { failing?: boolean }): string;

export function buildPackages(options: {
  scriptsDir: string;
  outDir: string;
  indexes: Record<PackageKind, string>;
  productName: string;
  version: string;
  env?: Env;
  say?: (line: string) => void;
}): Promise<Record<PackageKind, string>>;

export interface GateCheck {
  ok: boolean;
  what: string;
  detail: string;
}
export function gateChecks(input: {
  kind: PackageKind;
  entries: readonly string[];
  manifest: string;
  indexInside: Buffer | null;
  indexExpected: Buffer;
  machine: string | null;
  version: string;
}): GateCheck[];
export function gatePackage(input: { kind: PackageKind; file: string; index: Buffer; version: string }): GateCheck[];
export function gateLines(kind: PackageKind, checks: readonly GateCheck[]): { ok: boolean; lines: string[] };

export interface Published {
  target: string;
  sha256: string;
  bytes: number;
  renamed: { from: string; to: string; hadIndex: boolean }[];
}
export function publishPackages(options: { built: Record<PackageKind, string>; publishDir: string; stamp: string; say?: (line: string) => void }): Record<PackageKind, Published>;

export function buildMsixVmScript(spec: VmScriptSpec): string;

export interface VmStatus {
  step: string;
  state: 'OK' | 'FAIL' | 'INFO';
  detail: string;
  final: boolean;
  at: string;
  computer: string;
}
export function vmStatusProblem(kind: string, bytes: Buffer): string | null;
/** What the server takes for the report and the status of the VM, over its defaults. */
export const VM_UPLOAD_RULES: Readonly<{
  report: Readonly<{ limit: number; validate: () => null }>;
  status: Readonly<{ limit: number; replace: true; validate: (kind: string, bytes: Buffer) => string | null }>;
}>;
export function readVmStatus(bytes: Buffer): VmStatus;

export function stampOf(date: Date): string;
export function uniqueDir(parent: string, name: string): string;

export function run(
  argv: readonly string[],
  context?: { env?: Env; say?: (line: string) => void; root?: string; signal?: AbortSignal; now?: () => Date; linger?: Linger },
): Promise<number>;
