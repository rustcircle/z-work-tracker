// Folder choices for sync, used by the first-launch screen and by Settings. Nothing is connected
// until the user ticks a folder and presses the connect button.
import { useId, useState } from 'react';

import { useApp } from '../../app/store';
import { api } from '../../lib/api';
import type { Detected, FolderPreview, SyncProvider } from '../../lib/types';
import { Button } from '../../components/ui';
import { IconFolder } from '../../components/icons';
import { plural } from '../../components/format';
import { useCommands } from '../../components/useCommands';

export const providerName = (p: SyncProvider): string => (p === 'oneDrive' ? 'OneDrive' : p === 'googleDrive' ? 'Google Drive' : 'Chosen');
export const folderLabel = (d: { provider: SyncProvider; root: string }): string => (d.provider === 'custom' ? `Folder (${d.root})` : `${providerName(d.provider)} folder (${d.root})`);

export const SYNC_PRIVACY =
  "Your labor data leaves this computer only through the folder you choose: OneDrive or Google Drive for desktop, running on your own account, uploads it. This app has no server, sends nothing anywhere else and cannot see whether the upload finished.";

type Preview = { state: 'loading' } | { state: 'error'; message: string } | { state: 'ready'; preview: FolderPreview };

function PreviewText({ p }: { p: Preview }) {
  if (p.state === 'loading') return <p className="muted sync-preview">Looking inside the folder…</p>;
  if (p.state === 'error') return <p className="field-error sync-preview">Could not read this folder: {p.message}</p>;
  const v = p.preview;
  return (
    <div className="sync-preview" data-testid="sync-preview">
      {v.hasData ? (
        <p>
          This folder already holds Labor Tracker data from {plural(v.devices.length, 'device')}
          {v.devices.length > 0 && ` (${v.devices.join(', ')})`}: {plural(v.projects, 'project')}, {plural(v.tasks, 'task')}, {plural(v.segments, 'time segment')}. Connecting merges it with this computer's data. Nothing is deleted on either side.
        </p>
      ) : (
        <p className="muted">No Labor Tracker data in this folder yet. A LaborTracker folder will be created inside it.</p>
      )}
      {v.warnings.map((w) => (
        <p key={w} className="field-warning">
          {w}
        </p>
      ))}
    </div>
  );
}

export function SyncChooser({ detected, existing, onConnected, onSkip, skipLabel }: { detected: readonly Detected[]; existing: readonly string[]; onConnected?: () => void; onSkip?: () => void; skipLabel?: string }) {
  const { adopt, snapshot } = useApp();
  const { act } = useCommands();
  const base = useId();
  const [extra, setExtra] = useState<Detected[]>([]);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [previews, setPreviews] = useState<Map<string, Preview>>(new Map());
  const [busy, setBusy] = useState(false);

  const list = [...detected, ...extra].filter((d, i, a) => !existing.includes(d.root) && a.findIndex((x) => x.root === d.root) === i);

  function loadPreview(root: string): void {
    setPreviews((m) => new Map(m).set(root, { state: 'loading' }));
    api.previewSyncFolder(root).then(
      (preview) => setPreviews((m) => new Map(m).set(root, { state: 'ready', preview })),
      (e: unknown) => setPreviews((m) => new Map(m).set(root, { state: 'error', message: e && typeof e === 'object' && 'message' in e ? String((e as { message: unknown }).message) : String(e) })),
    );
  }

  function toggle(d: Detected, on: boolean): void {
    setPicked((s) => {
      const n = new Set(s);
      if (on) n.add(d.root);
      else n.delete(d.root);
      return n;
    });
    if (on && !previews.has(d.root)) loadPreview(d.root);
  }

  async function choose(): Promise<void> {
    const root = await api.pickSyncFolder().catch(() => null);
    if (!root) return;
    const d: Detected = { provider: 'custom', root, source: 'chosen by you' };
    setExtra((x) => (x.some((e) => e.root === root) ? x : [...x, d]));
    toggle(d, true);
  }

  async function connect(): Promise<void> {
    setBusy(true);
    try {
      for (const d of list.filter((x) => picked.has(x.root))) {
        if (!(await act(() => api.addSyncTarget(d.provider, d.root)))) return;
      }
      onConnected?.();
    } finally {
      setBusy(false);
    }
  }

  async function recheck(): Promise<void> {
    adopt(await api.getSnapshot());
  }

  return (
    <div className="sync-chooser">
      {list.length === 0 ? (
        <div className="sync-guide" data-testid="sync-guide">
          <h3>No OneDrive or Google Drive folder was found</h3>
          <p>This app syncs by writing its files into a folder that another app uploads for you. To use it between computers:</p>
          <ol>
            <li>Install and sign in to OneDrive (included with Windows) or Google Drive for desktop.</li>
            <li>Wait until its folder appears in File Explorer, then check again below.</li>
            <li>Or choose any folder that your own sync tool already keeps up to date.</li>
          </ol>
          <div className="inline-actions">
            <Button onClick={() => void recheck()}>Check again</Button>
          </div>
        </div>
      ) : (
        <ul className="sync-list" aria-label="Folders found">
          {list.map((d, i) => {
            const id = `${base}-${i}`;
            const p = previews.get(d.root);
            return (
              <li key={d.root}>
                <div className="check">
                  <input id={id} type="checkbox" checked={picked.has(d.root)} onChange={(e) => toggle(d, e.target.checked)} />
                  <label htmlFor={id}>{folderLabel(d)}</label>
                </div>
                <p className="field-hint">Found via {d.source}.</p>
                {picked.has(d.root) && p && <PreviewText p={p} />}
              </li>
            );
          })}
        </ul>
      )}
      <p className="sync-privacy">{SYNC_PRIVACY}</p>
      <div className="form-actions">
        <Button variant="primary" disabled={picked.size === 0 || busy} onClick={() => void connect()}>
          {picked.size > 1 ? `Connect ${picked.size} folders` : 'Connect folder'}
        </Button>
        <Button icon={<IconFolder />} onClick={() => void choose()}>
          Choose another folder
        </Button>
        {onSkip && (
          <Button variant="ghost" onClick={onSkip}>
            {skipLabel ?? 'Not now'}
          </Button>
        )}
      </div>
      {snapshot.sync.targets.length > 0 && picked.size === 0 && list.length === 0 && <span className="visually-hidden">Existing targets are listed above.</span>}
    </div>
  );
}
