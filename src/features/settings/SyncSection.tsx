import { useRef, useState } from 'react';

import { useApp } from '../../app/store';
import { api } from '../../lib/api';
import { parseIso } from '../../lib/tz';
import type { SyncTargetView } from '../../lib/types';
import { ago } from '../../components/format';
import { Button, ConfirmDialog } from '../../components/ui';
import { IconRefresh } from '../../components/icons';
import { useCommands } from '../../components/useCommands';
import { MovePanel, useMoveFlow } from './MoveFlow';
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
  const root = useRef<HTMLDivElement | null>(null);
  const move = useMoveFlow(root);
  const pending = snapshot.sync.pendingCopy;
  const copying = move.flow.phase === 'copying';

  return (
    <div className="settings-stack" ref={root}>
      <p className="sync-privacy">{SYNC_PRIVACY}</p>
      <p className="field-hint" data-testid="sync-when">
        Once a folder is connected, sync runs by itself: shortly after each major action (such as starting, pausing or stopping a task), shortly after text edits settle, every 30 minutes, when the app starts and when it quits. A failed attempt is retried after a wait that grows each time.
      </p>
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
                <div className="inline-actions">
                  <Button small disabled={move.busy} onClick={() => move.begin(t.root, true)}>
                    Change folder <span className="visually-hidden">{t.root}</span>
                  </Button>
                  <Button small variant="danger" disabled={copying} onClick={() => setRemoving(t)}>
                    Remove <span className="visually-hidden">{t.root}</span> (keeps files)
                  </Button>
                </div>
              </div>
              {pending && pending.to === t.root && (
                <div className="sync-pending" data-testid="sync-pending">
                  <p className="field-warning" role="status">
                    The previous folder ({pending.from}) couldn&apos;t be read when you switched, so its data has not been copied here yet. Sync is using the data on this computer.
                  </p>
                  <Button small disabled={move.busy} onClick={() => move.retryCopy(pending, t.provider)}>
                    Retry copy
                  </Button>
                </div>
              )}
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
          disabled={targets.length === 0 || syncing || copying}
          onClick={() => {
            setSyncing(true);
            void act(() => api.syncNow()).finally(() => setSyncing(false));
          }}
        >
          Sync now
        </Button>
        <Button
          aria-expanded={targets.length === 0 ? adding : move.flow.phase === 'choose' && !move.flow.replacing}
          disabled={move.busy && targets.length > 0}
          onClick={() => {
            const first = targets[0];
            if (first) move.begin(first.root, false);
            else setAdding((v) => !v);
          }}
        >
          Add a folder
        </Button>
      </div>
      <MovePanel actions={move} detected={snapshot.sync.detected} existing={targets.map((t) => t.root)} />
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
