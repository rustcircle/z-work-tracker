// The full history of changes, newest first: what changed, to what, when, and why.
import { useCallback, useEffect, useMemo, useState } from 'react';

import { useAppState } from '../../app/store';
import { api } from '../../lib/api';
import { Button, Field } from '../../components/ui';
import { IconRefresh } from '../../components/icons';
import type { AuditEntry } from '../../lib/types';
import { actionWords, auditLine, entityLabel } from './auditText';
import './p2time.css';
import { errorMessage } from '../../lib/errorMessage';

const PAGE = 50;

type Load = { status: 'loading' } | { status: 'error'; message: string } | { status: 'ready'; entries: AuditEntry[] };


export function AuditSection() {
  const { snapshot, zones } = useAppState();
  const [load, setLoad] = useState<Load>({ status: 'loading' });
  const [entity, setEntity] = useState('');
  const [count, setCount] = useState(PAGE);
  const [refreshing, setRefreshing] = useState(false);

  const fetchAll = useCallback(async (): Promise<Load> => {
    try {
      const entries = await api.getAudit(null);
      // Newest first, whatever order the backend used.
      return { status: 'ready', entries: [...entries].sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : a.id < b.id ? -1 : 1)) };
    } catch (e) {
      return { status: 'error', message: errorMessage(e) };
    }
  }, []);

  useEffect(() => {
    let alive = true;
    void fetchAll().then((r) => {
      if (alive) setLoad(r);
    });
    return () => {
      alive = false;
    };
  }, [fetchAll]);

  const reload = async (): Promise<void> => {
    setRefreshing(true);
    const r = await fetchAll();
    setLoad(r);
    setCount(PAGE);
    setRefreshing(false);
  };

  const entries = load.status === 'ready' ? load.entries : null;
  const kinds = useMemo(() => [...new Set((entries ?? []).map((e) => e.entity))].sort(), [entries]);
  const shown = useMemo(() => (entries ?? []).filter((e) => entity === '' || e.entity === entity), [entries, entity]);

  return (
    <div className="settings-stack">
      <p>Every correction, hand-entered time, answer about time away, billable pause and billing summary is recorded here with the time and, where there is one, the reason. Times are in {zones.active}.</p>
      <div className="inline-actions audit-controls">
        <Field label="Show" inline>
          {({ id }) => (
            <select id={id} className="input" value={entity} onChange={(e) => {
                setEntity(e.target.value);
                setCount(PAGE);
              }}>
              <option value="">All entries</option>
              {kinds.map((k) => (
                <option key={k} value={k}>
                  {entityLabel(k)}
                </option>
              ))}
            </select>
          )}
        </Field>
        <Button icon={<IconRefresh />} onClick={() => void reload()} disabled={refreshing}>
          Load
        </Button>
      </div>
      <div aria-live="polite">
        {load.status === 'loading' && <p className="muted">Loading the history…</p>}
        {load.status === 'error' && (
          <p className="field-error" role="alert">
            Could not load the history: {load.message}
          </p>
        )}
        {entries && shown.length === 0 && <p className="muted" data-testid="audit-empty">{entries.length === 0 ? 'Nothing has been recorded yet. Corrections, hand-entered time and billing summaries appear here.' : 'No entries of that kind.'}</p>}
      </div>
      {shown.length > 0 && (
        <>
          <p className="muted" data-testid="audit-count">
            {shown.length} {shown.length === 1 ? 'entry' : 'entries'}, newest first.
          </p>
          <ol className="audit-list" aria-label="History of changes">
            {shown.slice(0, count).map((e) => {
              const line = auditLine(e, zones.active, snapshot.deviceId, snapshot.deviceName);
              return (
                <li key={e.id} className="audit-entry" data-testid="audit-entry" data-entity={e.entity}>
                  <p className="audit-head">
                    <span className="tabular">{line.when}</span> <strong>{entityLabel(e.entity)}</strong> {actionWords(e.action)}
                    <span className="muted"> by {line.by}</span>
                  </p>
                  {e.reason && <p className="audit-reason">Reason: {e.reason}</p>}
                  <p className="audit-change muted">
                    Before: {line.before}. After: {line.after}.
                  </p>
                </li>
              );
            })}
          </ol>
          {shown.length > count && (
            <div>
              <Button onClick={() => setCount((c) => c + PAGE)}>Show {Math.min(PAGE, shown.length - count)} more</Button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
