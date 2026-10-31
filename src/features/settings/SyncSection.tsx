import { useState } from 'react';

import { useApp } from '../../app/store';
import { api } from '../../lib/api';
import { parseIso } from '../../lib/tz';
import type { SyncTargetView } from '../../lib/types';
import { ago } from '../../components/format';
import { Button, ConfirmDialog } from '../../components/ui';
import { IconRefresh } from '../../components/icons';
import { useCommands } from '../../components/useCommands';
import { SYNC_PRIVACY, SyncChooser, providerName } from './SyncChooser';

function writtenText(t: SyncTargetView, nowSec: number): string {
  const where = t.provider === 'custom' ? 'the chosen folder' : `${providerName(t.provider)} folder`;
  return t.status.lastWrittenAt ? `Written to ${where}, ${ago(parseIso(t.status.lastWrittenAt), nowSec)}` : `Nothing written to ${where} yet`;
}

export function SyncSection() {
  const { snapshot, nowSec } = useApp();
  const { act } = useCommands();
  const [adding, setAdding] = useState(false);
  const [removing, setRemoving] = useState<SyncTargetView | null>(null);
  const [syncing, setSyncing] = useState(false);
  const targets = snapshot.sync.targets;

  return (
    <div className="settings-stack">
      <p className="sync-privacy">{SYNC_PRIVACY}</p>
      {targets.length === 0 ? (
        <p className="muted">Sync is off. This device keeps its data only on this computer.</p>
      ) : (
        <ul className="sync-targets" aria-label="Sync folders">
          {targets.map((t) => (
            <li key={t.root} className="sync-target">
              <div className="sync-target-head">
                <div>
                  <h4>{t.provider === 'custom' ? 'Chosen folder' : `${providerName(t.provider)} folder`}</h4>
                  <p className="muted sync-path">{t.folder}</p>
                </div>
                <Button small variant="danger" onClick={() => setRemoving(t)}>
                  Remove <span className="visually-hidden">{t.root}</span> (keeps files)
                </Button>
              </div>
              <p data-testid="sync-written">{writtenText(t, nowSec)}</p>
              <p className="muted">
                {t.status.lastReadAt ? `Other devices' changes read ${ago(parseIso(t.status.lastReadAt), nowSec)}` : "Other devices' changes not read yet"} · {t.status.devicesSeen} other {t.status.devicesSeen === 1 ? 'device' : 'devices'} seen
                {t.status.ignoredFiles > 0 && ` · ${t.status.ignoredFiles} unreadable ${t.status.ignoredFiles === 1 ? 'file' : 'files'} ignored`}
              </p>
              <p className="field-hint">This app only writes the files. Your sync app uploads them, and this app cannot confirm that it has.</p>
              {t.status.warnings.map((w) => (
                <p key={w} className="field-warning" role="status">
                  {w}
                </p>
              ))}
              {t.status.lastError && (
                <p className="field-error" role="alert">
                  Last error{t.status.lastErrorAt ? ` (${ago(parseIso(t.status.lastErrorAt), nowSec)})` : ''}: {t.status.lastError}
                </p>
              )}
            </li>
          ))}
        </ul>
      )}
      <div className="inline-actions">
        <Button
          icon={<IconRefresh />}
          disabled={targets.length === 0 || syncing}
          onClick={() => {
            setSyncing(true);
            void act(() => api.syncNow()).finally(() => setSyncing(false));
          }}
        >
          Sync now
        </Button>
        <Button aria-expanded={adding} onClick={() => setAdding((v) => !v)}>
          Add a folder
        </Button>
      </div>
      {adding && <SyncChooser detected={snapshot.sync.detected} existing={targets.map((t) => t.root)} onConnected={() => setAdding(false)} onSkip={() => setAdding(false)} skipLabel="Cancel" />}
      <ConfirmDialog
        open={removing !== null}
        title="Stop syncing with this folder?"
        confirmLabel="Remove folder"
        danger
        onCancel={() => setRemoving(null)}
        onConfirm={() => {
          const t = removing;
          setRemoving(null);
          if (t) void act(() => api.removeSyncTarget(t.root));
        }}
      >
        <p>The files already in {removing?.folder} stay where they are, and so does your data here. This only stops this app reading and writing that folder.</p>
      </ConfirmDialog>
    </div>
  );
}
