export const DEFAULT_TIMESTAMP_URL: string;
export function chooseRoute(env: Record<string, string | undefined>, platform: string): { route?: string; error?: string };
export function buildCommand(
  route: string,
  env: Record<string, string | undefined>,
  file: string,
): { program: string; args: string[]; shown: string; needsPassFile?: boolean };
