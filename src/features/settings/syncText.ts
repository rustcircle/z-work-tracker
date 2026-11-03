// Words about the sync folders that Settings > Sync between devices and Settings > Versions both use.
import { clock, dayLabel } from '../../components/format';
import { dayOf } from '../../lib/tz';
import type { SyncProvider, SyncTargetView } from '../../lib/types';

/** "OneDrive", "Google Drive", or the last part of the path of a folder the user chose. */
export function folderName(provider: SyncProvider, root: string): string {
  if (provider === 'oneDrive') return 'OneDrive';
  if (provider === 'googleDrive') return 'Google Drive';
  return root.split(/[\\/]/).filter(Boolean).pop() ?? 'Chosen folder';
}

/** "Thu 12 Mar 2026, 14:20" on the wall clock of `zone`. */
export function whenLabel(sec: number, zone: string): string {
  return `${dayLabel(dayOf(sec, zone))}, ${clock(sec, zone)}`;
}

/** "40 min", "3 h", "2 d": a length of time, for a sentence that already says what it is the length of. */
export function spanWords(secs: number): string {
  const s = Math.max(0, Math.round(secs));
  if (s < 90 * 60) return `${Math.max(1, Math.round(s / 60))} min`;
  if (s < 48 * 3600) return `${Math.round(s / 3600)} h`;
  return `${Math.round(s / 86_400)} d`;
}

export interface FolderHealth {
  tone: 'success' | 'warning' | 'danger' | 'neutral';
  label: 'Problem' | 'Behind' | 'Working' | 'Not synced yet';
}

/**
 * One word for how a folder is doing, so a failing one is seen at a glance and the other one is not tarred with it.
 * Every folder is judged on its own: a problem is an error of its own, or a folder that can't be read just now.
 */
export function folderHealth(t: SyncTargetView, unreachable: boolean): FolderHealth {
  const s = t.status;
  if (unreachable || s.lastError || s.leaseError || s.lastVersionError) return { tone: 'danger', label: 'Problem' };
  if (typeof s.lagSecs === 'number' && s.lagSecs > 0) return { tone: 'warning', label: 'Behind' };
  if (s.lastWrittenAt === null) return { tone: 'neutral', label: 'Not synced yet' };
  return { tone: 'success', label: 'Working' };
}
