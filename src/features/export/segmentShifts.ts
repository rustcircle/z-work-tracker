// The text shown in the export's "shifts" column for each raw segment: how its time splits across
// shift windows and time outside any shift, such as "Morning 1:00:00; Outside 0:30:00".
import { attributeSpan, windowsFor, type ShiftWindow } from '../../lib/shifts';
import type { Seg } from '../../lib/split';
import type { ShiftVersion } from '../../lib/types';
import { formatHMS } from '../../components/format';

const MAX_WINDOW_SECS = 3 * 86400;

/** First index whose window starts at or after `t` (windows are sorted by start). */
function lowerBound(w: readonly ShiftWindow[], t: number): number {
  let lo = 0;
  let hi = w.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if ((w[mid] as ShiftWindow).start < t) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

export function segmentShiftText(segs: readonly Seg[], shifts: readonly ShiftVersion[]): Record<string, string> {
  const out: Record<string, string> = {};
  if (!shifts.some((v) => !v.deleted)) return out;
  const real = segs.filter((s) => s.end > s.start);
  if (real.length === 0) return out;
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  for (const s of real) {
    if (s.start < min) min = s.start;
    if (s.end > max) max = s.end;
  }
  const windows = windowsFor(shifts, min, max);
  for (const s of real) {
    const slice = windows.slice(lowerBound(windows, s.start - MAX_WINDOW_SECS), lowerBound(windows, s.end));
    const totals = new Map<string, number>();
    for (const part of attributeSpan(s.start, s.end, slice)) {
      const name = part.window?.name ?? 'Outside';
      totals.set(name, (totals.get(name) ?? 0) + (part.end - part.start));
    }
    out[s.id] = [...totals.entries()].map(([name, secs]) => `${name} ${formatHMS(secs)}`).join('; ');
  }
  return out;
}
