// A readable audit list, and the hook that loads it from the backend.
import { useEffect, useMemo, useState } from 'react';

import { useAppState } from '../../../app/store';
import { api } from '../../../lib/api';
import type { AuditEntry } from '../../../lib/types';
import { toCommandError } from './attempt';
import { describeAudit, type AuditLine } from './derive';

type Loaded = { for: string | null; entries: AuditEntry[] } | { for: string | null; error: string };

/** Loads `get_audit` and reloads whenever a new snapshot arrives, since every change writes an entry. */
export function useAudit(entityId: string | null): { entries: AuditEntry[] | null; error: string | null } {
  const { snapshot } = useAppState();
  const [result, setResult] = useState<Loaded | null>(null);
  useEffect(() => {
    let alive = true;
    api.getAudit(entityId).then(
      (entries) => {
        if (alive) setResult({ for: entityId, entries });
      },
      (e: unknown) => {
        if (alive) setResult({ for: entityId, error: toCommandError(e).message });
      },
    );
    return () => {
      alive = false;
    };
  }, [entityId, snapshot]);
  const current = result && result.for === entityId ? result : null;
  if (!current) return { entries: null, error: null };
  return 'error' in current ? { entries: null, error: current.error } : { entries: current.entries, error: null };
}

export function useAuditLines(entries: readonly AuditEntry[]): AuditLine[] {
  const { snapshot, zones } = useAppState();
  return useMemo(
    () => entries.map((e) => describeAudit(e, { zone: zones.active, deviceId: snapshot.deviceId, rawSegments: snapshot.rawSegments, gaps: snapshot.gaps })),
    [entries, zones.active, snapshot.deviceId, snapshot.rawSegments, snapshot.gaps],
  );
}

export function AuditList({ entries, error, label, showAbout = true }: { entries: readonly AuditEntry[] | null; error: string | null; label: string; showAbout?: boolean }) {
  const lines = useAuditLines(entries ?? []);
  if (error) return <p className="field-error" role="alert">Could not load the history: {error}</p>;
  if (entries === null) return <p className="muted" role="status">Loading the history…</p>;
  if (lines.length === 0) return <p className="muted">Nothing has changed here yet.</p>;
  return (
    <ol className="audit-list" aria-label={label}>
      {lines.map((l) => (
        <li key={l.id} className="audit-item">
          <div className="audit-head">
            <strong>{l.what}</strong>
            <span className="muted tabular">{l.when}</span>
            {l.elsewhere && <span className="badge">From another device</span>}
          </div>
          {showAbout && <div className="audit-about">{l.about}</div>}
          {l.change && <div className="audit-change">{l.change}</div>}
          {l.reason && <div className="audit-reason">Reason: {l.reason}</div>}
        </li>
      ))}
    </ol>
  );
}
