// WCAG contrast, readable text on project colours, and the curated project palette.

export function parseHex(hex: string): [number, number, number] {
  const n = Number.parseInt(hex.replace('#', ''), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

export function luminance(hex: string): number {
  const [r, g, b] = parseHex(hex).map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function contrast(a: string, b: string): number {
  const la = luminance(a);
  const lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/** Black or white, whichever reads better. One of them always reaches WCAG AA 4.5:1. */
export const readableText = (bg: string): '#000000' | '#ffffff' => (contrast(bg, '#000000') >= contrast(bg, '#ffffff') ? '#000000' : '#ffffff');

export const PROJECT_PALETTE = [
  '#2563eb', '#dc2626', '#059669', '#d97706', '#7c3aed', '#db2777',
  '#0891b2', '#65a30d', '#ea580c', '#4f46e5', '#0d9488', '#be123c',
] as const;

/** The first palette colour no project uses, else the least used. */
export function suggestColor(used: readonly string[]): string {
  const lower = used.map((c) => c.toLowerCase());
  let best: string = PROJECT_PALETTE[0];
  let bestCount = Number.POSITIVE_INFINITY;
  for (const c of PROJECT_PALETTE) {
    const count = lower.filter((u) => u === c).length;
    if (count < bestCount) {
      best = c;
      bestCount = count;
    }
  }
  return best;
}
