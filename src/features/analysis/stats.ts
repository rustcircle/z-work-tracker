// Small statistics helpers. Every function returns null instead of NaN when there is nothing to compute.
export const sum = (xs: readonly number[]): number => xs.reduce((a, b) => a + b, 0);

export const mean = (xs: readonly number[]): number | null => (xs.length ? sum(xs) / xs.length : null);

/** Quantile of an ascending array, linear interpolation between ranks (R type 7). */
export function quantileSorted(sorted: ArrayLike<number>, q: number): number | null {
  const n = sorted.length;
  if (n === 0) return null;
  const pos = (n - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  const a = sorted[lo] as number;
  const b = sorted[hi] as number;
  return a + (b - a) * (pos - lo);
}

export const median = (xs: readonly number[]): number | null => quantileSorted([...xs].sort((a, b) => a - b), 0.5);

export function stdPop(xs: readonly number[]): number | null {
  const m = mean(xs);
  if (m === null) return null;
  return Math.sqrt(sum(xs.map((x) => (x - m) ** 2)) / xs.length);
}

/** `part / whole`, or null when the whole is zero. */
export const ratio = (part: number, whole: number): number | null => (whole > 0 ? part / whole : null);

export interface Delta {
  value: number;
  prev: number;
  abs: number;
  /** Change as a fraction of the previous value; null when the previous value is zero. */
  pct: number | null;
}

export function delta(value: number | null, prev: number | null | undefined): Delta | null {
  if (value === null || prev === null || prev === undefined) return null;
  return { value, prev, abs: value - prev, pct: prev !== 0 ? (value - prev) / prev : null };
}

/** The index of the largest value, first on ties; null when all are zero. */
export function argMax(xs: readonly number[]): number | null {
  let best = -1;
  let bv = 0;
  xs.forEach((x, i) => {
    if (x > bv) {
      bv = x;
      best = i;
    }
  });
  return best < 0 ? null : best;
}

export function argMin(xs: readonly number[]): number | null {
  if (!xs.length) return null;
  let best = 0;
  xs.forEach((x, i) => {
    if (x < (xs[best] as number)) best = i;
  });
  return best;
}
