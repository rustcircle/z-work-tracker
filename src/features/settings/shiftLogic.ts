// Pure helpers for the shifts editor: validation, presets and a readable summary.
import { groupVersions, versionOn } from '../../lib/shifts';
import { cityOf, hhmmToMinutes } from '../../lib/tz';
import type { ShiftInput, ShiftVersion } from '../../lib/types';
import { WEEKDAY_NAMES } from '../../components/format';

export interface ShiftDraft {
  shiftId: string | null;
  name: string;
  color: string;
  start: string;
  end: string;
  weekdays: number[];
  zone: string;
  breakMinutes: string;
  effectiveFrom: string;
}

export const PRESETS = [
  { name: 'Morning', start: '06:00', end: '14:00', color: '#0891b2' },
  { name: 'Afternoon', start: '14:00', end: '22:00', color: '#d97706' },
  { name: 'Night', start: '22:00', end: '06:00', color: '#7c3aed' },
] as const;

export const WEEKDAYS_ALL = [1, 2, 3, 4, 5, 6, 7] as const;

export type DraftCheck = { ok: true; input: ShiftInput } | { ok: false; errors: Partial<Record<'name' | 'weekdays' | 'time' | 'break', string>> };

export function checkShift(d: ShiftDraft): DraftCheck {
  const errors: Partial<Record<'name' | 'weekdays' | 'time' | 'break', string>> = {};
  if (d.name.trim() === '') errors.name = 'Enter a shift name.';
  if (d.weekdays.length === 0) errors.weekdays = 'Choose at least one weekday.';
  const timeOk = /^\d{2}:\d{2}$/;
  if (!timeOk.test(d.start) || !timeOk.test(d.end)) errors.time = 'Enter a start and an end time.';
  else if (d.start === d.end) errors.time = 'Start and end must differ. An end before the start runs overnight.';
  const brk = d.breakMinutes.trim() === '' ? 0 : Number(d.breakMinutes);
  if (!Number.isInteger(brk) || brk < 0 || brk > 600) errors.break = 'Enter whole minutes from 0 to 600.';
  if (Object.keys(errors).length > 0) return { ok: false, errors };
  return {
    ok: true,
    input: { shiftId: d.shiftId, effectiveFrom: d.effectiveFrom, name: d.name.trim(), color: d.color, start: d.start, end: d.end, weekdays: [...d.weekdays].sort((a, b) => a - b), zone: d.zone, breakMinutes: brk },
  };
}

export const runsOvernight = (start: string, end: string): boolean => /^\d{2}:\d{2}$/.test(start) && /^\d{2}:\d{2}$/.test(end) && hhmmToMinutes(end) <= hhmmToMinutes(start);

export function weekdaysText(days: readonly number[]): string {
  const s = [...days].sort((a, b) => a - b);
  if (s.length === 7) return 'Every day';
  if (s.join() === '1,2,3,4,5') return 'Weekdays';
  if (s.join() === '6,7') return 'Weekends';
  return s.map((d) => (WEEKDAY_NAMES[d - 1] as string).slice(0, 3)).join(', ');
}

export function summary(v: ShiftVersion): string {
  return `${v.start}–${v.end}${runsOvernight(v.start, v.end) ? ' (next day)' : ''}, ${weekdaysText(v.weekdays)}, ${cityOf(v.zone)}${v.breakMinutes ? `, ${v.breakMinutes} min break` : ''}`;
}

export interface ShiftGroup {
  shiftId: string;
  /** Newest effective date first. */
  versions: ShiftVersion[];
  /** The version in force on `today`, else the newest one. */
  current: ShiftVersion;
  retired: boolean;
}

export function shiftGroups(all: readonly ShiftVersion[], today: string): ShiftGroup[] {
  const out: ShiftGroup[] = [];
  for (const [shiftId, list] of groupVersions(all)) {
    const versions = [...list].sort((a, b) => (a.effectiveFrom === b.effectiveFrom ? (a.id < b.id ? 1 : -1) : a.effectiveFrom < b.effectiveFrom ? 1 : -1));
    const inForce = versions.find((v) => v.effectiveFrom <= today);
    const current = (inForce ?? versions[versions.length - 1]) as ShiftVersion;
    out.push({ shiftId, versions, current, retired: versionOn(list, today) === null && inForce !== undefined });
  }
  return out.sort((a, b) => (a.current.name < b.current.name ? -1 : 1));
}
