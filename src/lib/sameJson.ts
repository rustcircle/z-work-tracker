/** The same JSON, whatever the order of its keys, as the backend compares it: it stores objects with sorted keys and the editor doesn't. */
export function sameJson(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null || Array.isArray(a) !== Array.isArray(b)) return false;
  const [ka, kb] = [Object.keys(a), Object.keys(b)];
  return ka.length === kb.length && ka.every((k) => k in b && sameJson((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
}
