// Dated copies of the data kept on this computer, how many to keep, and restoring one.
import { useCallback, useEffect, useState } from 'react';

import { useAppState } from '../../app/store';
import { api } from '../../lib/api';
import { Badge, Button, ConfirmDialog, Field } from '../../components/ui';
import type { BackupInfo } from '../../lib/types';
import './p2time.css';
import { errorMessage } from '../../lib/errorMessage';

type Load = { status: 'loading' } | { status: 'error'; message: string } | { status: 'ready'; list: BackupInfo[] };


/** "48 KB", "1.2 MB". */
export function bytesText(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function parseKeep(text: string): { ok: true; keep: number } | { ok: false; message: string } {
  const t = text.trim();
  if (!/^\d+$/.test(t) || Number(t) < 1 || Number(t) > 365) return { ok: false, message: 'Enter a whole number from 1 to 365.' };
  return { ok: true, keep: Number(t) };
}

function KeepField({ keep }: { keep: number }) {
  const { adopt } = useAppState();
  // What is typed, or null while the field just shows the saved value: a save keeps this form mounted,
  // so "Saved." and the focus stay.
  const [draft, setDraft] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const value = draft ?? String(keep);
  const save = async (): Promise<void> => {
    setSaved(false);
    const parsed = parseKeep(value);
    if (!parsed.ok) {
      setError(parsed.message);
      return;
    }
    setError(null);
    try {
      adopt(await api.setBackupKeep(parsed.keep));
      setDraft(null);
      setSaved(true);
    } catch (e) {
      setError(errorMessage(e));
    }
  };
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      <Field label="Daily backups to keep" hint="Older ones are removed. Between 1 and 365." error={error}>
        {({ id, describedBy }) => (
          <div className="inline-actions">
            <input id={id} className="input input-narrow" type="text" inputMode="numeric" value={value} onChange={(e) => {
              setDraft(e.target.value);
              setSaved(false);
            }} aria-describedby={describedBy} aria-invalid={error ? true : undefined} />
            <Button type="submit">Save</Button>
            <span className="muted" data-testid="backup-keep-now">
              Now: {keep}
            </span>
            <span className="muted" role="status">
              {saved ? 'Saved.' : ''}
            </span>
          </div>
        )}
      </Field>
    </form>
  );
}

export function BackupsSection() {
  const { snapshot, adopt } = useAppState();
  const [load, setLoad] = useState<Load>({ status: 'loading' });
  const [restoring, setRestoring] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);

  const fetchList = useCallback(async (): Promise<Load> => {
    try {
      return { status: 'ready', list: await api.listBackups() };
    } catch (e) {
      return { status: 'error', message: errorMessage(e) };
    }
  }, []);

  useEffect(() => {
    let alive = true;
    void fetchList().then((r) => {
      if (alive) setLoad(r);
    });
    return () => {
      alive = false;
    };
  }, [fetchList]);

  const restore = async (name: string): Promise<void> => {
    setBusy(true);
    setResult(null);
    try {
      adopt(await api.restoreBackup(name));
      setResult({ ok: true, text: `Restored ${name}. A safety copy of the data from just before is in the list. The notices at the top of the window say what to expect.` });
    } catch (e) {
      setResult({ ok: false, text: `Could not restore ${name}: ${errorMessage(e)}` });
    } finally {
      setBusy(false);
    }
    setLoad(await fetchList());
  };

  return (
    <div className="settings-stack">
      <p>
        zWorkTracker keeps a dated copy of your data on this computer. Backups are separate from sync: they never leave this computer, and they are not shared with your other devices.
      </p>
      <KeepField keep={snapshot.backupKeep} />
      <div aria-live="polite">
        {result && (
          <p className={result.ok ? 'backup-result' : 'field-error'} role={result.ok ? 'status' : 'alert'} data-testid="backup-result">
            {result.text}
          </p>
        )}
      </div>
      {load.status === 'loading' && <p className="muted">Loading the backups…</p>}
      {load.status === 'error' && (
        <p className="field-error" role="alert">
          Could not list the backups: {load.message}
        </p>
      )}
      {load.status === 'ready' && load.list.length === 0 && <p className="muted">No backup has been made yet. The first one is made automatically.</p>}
      {load.status === 'ready' && load.list.length > 0 && (
        <ul className="backup-list" aria-label="Backups, newest first">
          {load.list.map((b) => (
            <li key={b.name} className="backup-row" data-testid="backup-row">
              <span className="backup-name">{b.name}</span>
              {b.safety && (
                <Badge tone="accent" title="Made automatically just before a restore, so the data it replaced can be brought back">
                  Safety copy
                </Badge>
              )}
              <span className="muted tabular">{bytesText(b.bytes)}</span>
              <Button small disabled={busy} aria-label={`Restore ${b.name}`} onClick={() => setRestoring(b.name)}>
                Restore
              </Button>
            </li>
          ))}
        </ul>
      )}
      <ConfirmDialog
        open={restoring !== null}
        title="Restore this backup?"
        confirmLabel="Restore this backup"
        danger
        onCancel={() => setRestoring(null)}
        onConfirm={() => {
          const name = restoring;
          setRestoring(null);
          if (name) void restore(name);
        }}
      >
        <p>
          <strong>{restoring}</strong> replaces the data on this computer.
        </p>
        <ul className="plain-list">
          <li>A safety copy of the current data is made first, so you can go back.</li>
          <li>A running task is paused.</li>
          <li>The next start asks for every field again, like a fresh launch.</li>
          <li>With sync on, newer records in your sync folders merge back in at the next sync.</li>
        </ul>
        <p className="muted">Backups are separate from sync and stay on this computer.</p>
      </ConfirmDialog>
    </div>
  );
}
