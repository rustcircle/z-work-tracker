// Pure helpers for time away: which gaps are pending, how long, and the words for them.
import { formatDuration } from '../../components/format';
import { parseIso } from '../../lib/tz';
import type { GapKind, IdleGap, Task } from '../../lib/types';

export const UNCONFIRMED = 'Unconfirmed: not counted until you confirm';

export const pendingGaps = (gaps: readonly IdleGap[]): IdleGap[] => gaps.filter((g) => g.decision === 'pending').sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : a.id < b.id ? -1 : 1));

export const gapSecs = (g: Pick<IdleGap, 'start' | 'end'>): number => Math.max(0, parseIso(g.end) - parseIso(g.start));

export const totalSecs = (gaps: readonly IdleGap[]): number => gaps.reduce((n, g) => n + gapSecs(g), 0);

/** "Logo concepts", "Logo concepts and Print proofs", "Logo concepts, Print proofs and 2 more". */
export function taskNames(gaps: readonly IdleGap[], tasks: ReadonlyMap<string, Task>): string {
  const names = [...new Set(gaps.map((g) => tasks.get(g.taskId)?.name ?? 'a task'))];
  if (names.length <= 2) return names.join(' and ');
  return `${names.slice(0, 2).join(', ')} and ${names.length - 2} more`;
}

/** The words for each kind of time away. A `Record` keeps every screen in step when a kind is added. */
const GAP_TEXT: Record<GapKind, { word: string; title: string; sentence: string }> = {
  sleep: { word: 'Sleep', title: 'The computer was asleep', sentence: 'The computer was asleep' },
  idle: { word: 'Idle', title: 'No keyboard or mouse activity', sentence: 'No activity' },
  lock: { word: 'Screen locked', title: 'The session was locked', sentence: 'The screen was locked' },
};

/** The badge word: "Sleep", "Idle", "Screen locked". */
export const gapWord = (g: Pick<IdleGap, 'kind'>): string => GAP_TEXT[g.kind].word;

/** A tooltip saying what happened. */
export const gapTitle = (g: Pick<IdleGap, 'kind'>): string => GAP_TEXT[g.kind].title;

/** A short sentence for a day card: "The computer was asleep", "No activity", "The screen was locked". */
export const gapSentence = (kind: GapKind): string => GAP_TEXT[kind].sentence;

/** "4 h 05 min", "35 min": the length of a run in words, to the nearest minute. */
export function longRunText(secs: number): string {
  const total = Math.max(0, Math.round(secs / 60));
  const h = Math.floor(total / 60);
  const m = total % 60;
  if (h === 0) return `${m} min`;
  return m === 0 ? `${h} h` : `${h} h ${String(m).padStart(2, '0')} min`;
}

export const lengthText = (g: Pick<IdleGap, 'start' | 'end'>): string => formatDuration(gapSecs(g));
