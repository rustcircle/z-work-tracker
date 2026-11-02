export function findInstaller(
  nsisDir: string,
  conf: { productName?: unknown; version?: unknown },
): { path: string; error?: never } | { path?: never; error: string };
