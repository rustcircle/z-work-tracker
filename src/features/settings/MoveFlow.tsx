// Changing or adding a sync folder with the data carried over. The flow is an inline panel, not a
// dialog, so the rest of the app stays usable while a copy runs. Nothing changes until the user
// confirms, and a failed copy changes nothing.
import { createContext, useCallback, useContext, useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react';

import { useAppState } from '../../app/store';
import { api, events } from '../../lib/api';
import type { DataCounts, Detected, MovePreview, MoveProgress, MoveResult, PendingCopy, SyncProvider } from '../../lib/types';
import { Button } from '../../components/ui';
import { plural } from '../../components/format';
import { SyncChooser } from './SyncChooser';
import { errorMessage } from '../../lib/errorMessage';

interface Params {
  from: string | null;
  to: Detected;
  replacing: boolean;
}

type PreviewState = { state: 'loading' } | { state: 'error'; message: string } | { state: 'ready'; preview: MovePreview };

export type Flow =
  | { phase: 'idle' }
  | { phase: 'choose'; from: string | null; replacing: boolean }
  | { phase: 'confirm'; params: Params; preview: PreviewState }
  | { phase: 'copying'; params: Params; progress: MoveProgress | null; retry: boolean }
  | { phase: 'done'; params: Params; result: MoveResult; retry: boolean }
  | { phase: 'failed'; params: Params; message: string; retry: boolean };


export const countsText = (c: DataCounts): string => `${plural(c.projects, 'project')}, ${plural(c.tasks, 'task')}, ${plural(c.segments, 'time segment')}`;
const devicesText = (names: readonly string[]): string => (names.length === 0 ? 'no other devices' : `${plural(names.length, 'device')} (${names.join(', ')})`);

/**
 * What a move did, in words. This device's own file is always written, so a single PC copies no files
 * and that is a success; the numbers are about the files of other devices only.
 */
export function copiedText(r: Pick<MoveResult, 'filesCopied' | 'filesAlreadyThere' | 'filesIgnored'>): string {
  const ignored = r.filesIgnored > 0 ? ` ${plural(r.filesIgnored, 'file')} ignored.` : '';
  if (r.filesCopied === 0 && r.filesAlreadyThere === 0) return `There were no files from other devices to copy.${ignored}`;
  if (r.filesCopied === 0) return `No files from other devices needed copying: ${r.filesAlreadyThere} already there.${ignored}`;
  return `Copied ${plural(r.filesCopied, 'file')} from other devices, ${r.filesAlreadyThere} already there.${ignored}`;
}

export interface MoveActions {
  flow: Flow;
  busy: boolean;
  /** The Sync section tells which element it is while it is on the page, and null when it goes: focus falls back to its first button when the panel closes and the button that opened it is gone. */
  attach: (section: HTMLElement | null) => void;
  /** Opens the folder chooser. `from` is the folder being replaced, or the first existing folder when adding. */
  begin: (from: string | null, replacing: boolean) => void;
  /** Copies again into a folder that was switched to while the previous one could not be read. */
  retryCopy: (pending: PendingCopy, provider: SyncProvider) => void;
  pick: (d: Detected) => void;
  confirm: () => void;
  cancel: () => void;
}

export function useMoveFlow(): MoveActions {
  const { adopt } = useAppState();
  const [flow, setFlow] = useState<Flow>({ phase: 'idle' });
  const root = useRef<HTMLElement | null>(null);
  const attach = useCallback((section: HTMLElement | null): void => {
    root.current = section;
  }, []);
  const seq = useRef(0);
  const opener = useRef<HTMLElement | null>(null);
  const restore = useRef(false);

  const remember = (): void => {
    opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  };

  // After the panel closes, focus goes back to where it was opened, or to the section's first button.
  const idle = flow.phase === 'idle';
  useEffect(() => {
    if (!idle || !restore.current) return;
    restore.current = false;
    const target = opener.current?.isConnected ? opener.current : root.current?.querySelector<HTMLElement>('button:not([disabled])');
    target?.focus();
  }, [idle]);

  const close = useCallback((): void => {
    seq.current += 1;
    restore.current = true;
    setFlow({ phase: 'idle' });
  }, []);

  const run = useCallback(
    async (params: Params, retry: boolean): Promise<void> => {
      setFlow({ phase: 'copying', params, progress: null, retry });
      let unlisten: (() => void) | null = null;
      try {
        unlisten = await events.onSyncMoveProgress((p) => setFlow((f) => (f.phase === 'copying' ? { ...f, progress: p } : f)));
      } catch {
        // Progress is a courtesy; the copy still runs without it.
      }
      try {
        const result = await api.moveSyncTarget(params.from, params.to.root, params.to.provider, params.replacing);
        try {
          adopt(await api.getSnapshot());
        } catch {
          // The result is shown either way; the next state-changed event refreshes the list.
        }
        setFlow({ phase: 'done', params, result, retry });
      } catch (e) {
        setFlow({ phase: 'failed', params, message: errorMessage(e), retry });
        // A refusal can leave something behind that only the snapshot tells of, such as the question about a folder that holds a restore.
        // The backend sends no event for a move that failed, so the page asks.
        void api.getSnapshot().then(adopt, () => undefined);
      } finally {
        unlisten?.();
      }
    },
    [adopt],
  );

  const begin = useCallback((from: string | null, replacing: boolean): void => {
    remember();
    setFlow({ phase: 'choose', from, replacing });
  }, []);

  const pick = useCallback(
    (d: Detected): void => {
      if (flow.phase !== 'choose') return;
      const { from, replacing } = flow;
      const id = (seq.current += 1);
      setFlow({ phase: 'confirm', params: { from, to: d, replacing }, preview: { state: 'loading' } });
      api.previewSyncMove(from, d.root).then(
        (preview) => {
          if (seq.current === id) setFlow((f) => (f.phase === 'confirm' ? { ...f, preview: { state: 'ready', preview } } : f));
        },
        (e: unknown) => {
          if (seq.current === id) setFlow((f) => (f.phase === 'confirm' ? { ...f, preview: { state: 'error', message: errorMessage(e) } } : f));
        },
      );
    },
    [flow],
  );

  const confirm = useCallback((): void => {
    if (flow.phase === 'confirm') void run(flow.params, false);
    else if (flow.phase === 'failed') void run(flow.params, flow.retry);
  }, [flow, run]);

  const retryCopy = useCallback(
    (pending: PendingCopy, provider: SyncProvider): void => {
      remember();
      void run({ from: pending.from, to: { provider, root: pending.to, source: 'the folder you switched to' }, replacing: false }, true);
    },
    [run],
  );

  return useMemo(() => ({ flow, busy: flow.phase !== 'idle', attach, begin, retryCopy, pick, confirm, cancel: close }), [flow, attach, begin, retryCopy, pick, confirm, close]);
}

const MoveFlowContext = createContext<MoveActions | null>(null);

/**
 * Holds the flow above the tabs, which unmount when another is shown. A copy under way, and what it came to, are then still
 * there when Settings is opened again, and what starts a second one waits for it.
 */
export function MoveFlowProvider({ children }: { children: ReactNode }) {
  const move = useMoveFlow();
  return <MoveFlowContext.Provider value={move}>{children}</MoveFlowContext.Provider>;
}

/** The flow kept by `MoveFlowProvider`. */
export function useSharedMoveFlow(): MoveActions {
  const v = useContext(MoveFlowContext);
  if (!v) throw new Error('useSharedMoveFlow needs MoveFlowProvider');
  return v;
}

function Facts({ params, p }: { params: Params; p: MovePreview }) {
  return (
    <dl className="sync-move-facts">
      {params.from !== null && (
        <>
          <dt>{params.replacing ? 'Previous folder' : 'Existing folder'}</dt>
          <dd data-testid="move-from">
            <span className="sync-path">{params.from}</span>
            <span>{p.sourceAvailable ? `${devicesText(p.sourceDevices)}: ${countsText(p.sourceCounts)}` : "Can't be read right now"}</span>
          </dd>
        </>
      )}
      <dt>New folder</dt>
      <dd data-testid="move-to">
        <span className="sync-path">{params.to.root}</span>
        <span>{p.destinationHasData ? `${devicesText(p.destinationDevices)}: ${countsText(p.destinationCounts)}` : 'Nothing there yet'}</span>
      </dd>
      <dt>This computer</dt>
      <dd data-testid="move-local">{countsText(p.localCounts)}</dd>
    </dl>
  );
}

function Notes({ replacing }: { replacing: boolean }) {
  return (
    <div className="sync-move-notes">
      {replacing ? (
        <>
          <p>The old folder is not changed or deleted. It stops being written to, and you can remove it yourself.</p>
          <p data-testid="move-each-pc" className="field-warning">
            Each PC needs switching. Other PCs keep using the old folder until you change them too, and PCs on different folders don&apos;t see each other&apos;s changes.
          </p>
        </>
      ) : (
        <>
          <p>The existing folder is not changed or deleted. This computer writes to both folders from now on.</p>
          <p data-testid="move-each-pc" className="field-warning">
            Each PC needs the same change. Other PCs only use the folders they already have until you add this one there too, and PCs on different folders don&apos;t see each other&apos;s changes.
          </p>
        </>
      )}
    </div>
  );
}

export function MovePanel({ actions, detected, existing }: { actions: MoveActions; detected: readonly Detected[]; existing: readonly string[] }) {
  const { flow } = actions;
  const heading = useRef<HTMLHeadingElement | null>(null);
  const titleId = useId();
  const phase = flow.phase;
  // The heading takes focus when the panel opens or goes on to its next step, not when the page is shown again with a step under way.
  const shown = useRef(phase);
  useEffect(() => {
    if (shown.current !== phase && phase !== 'idle') heading.current?.focus();
    shown.current = phase;
  }, [phase]);
  if (flow.phase === 'idle') return null;

  const replacing = flow.phase === 'choose' ? flow.replacing : flow.params.replacing;
  const keepLine = replacing ? 'Sync is still using the old folder. Your data is safe.' : 'Sync is still using the folders it had. Your data is safe.';

  let title: string;
  let body: ReactNode;
  switch (flow.phase) {
    case 'choose':
      title = replacing ? 'Choose the new sync folder' : 'Choose a folder to add';
      body = (
        <>
          {flow.from !== null && replacing && <p className="muted sync-path">Replacing {flow.from}</p>}
          <SyncChooser detected={detected} existing={existing} onPick={actions.pick} pickLabel="Continue" onSkip={actions.cancel} skipLabel="Cancel" />
        </>
      );
      break;
    case 'confirm': {
      title = replacing ? 'Change the sync folder?' : 'Add this sync folder?';
      const pv = flow.preview;
      const ready = pv.state === 'ready' ? pv.preview : null;
      body = (
        <>
          {pv.state === 'loading' && <p className="muted">Looking inside the folders…</p>}
          {pv.state === 'error' && <p className="field-error" role="alert">Could not read the folders: {pv.message}</p>}
          {ready && (
            <>
              <Facts params={flow.params} p={ready} />
              {ready.destinationHasData && (
                <p data-testid="move-merge">
                  <strong>Existing data there will be merged, not overwritten.</strong>
                </p>
              )}
              {flow.params.from !== null && !ready.sourceAvailable && (
                <p className="field-warning" role="status" data-testid="move-source-missing">
                  The previous folder can&apos;t be read. This will use the data on this computer, and you can retry the copy later.
                </p>
              )}
              {ready.warnings.map((w) => (
                <p key={w} className="field-warning">
                  {w}
                </p>
              ))}
            </>
          )}
          <Notes replacing={replacing} />
          <div className="form-actions">
            <Button variant="primary" disabled={!ready} onClick={actions.confirm}>
              {ready && !ready.sourceAvailable ? 'Switch folder' : replacing ? 'Copy and switch' : 'Copy and add'}
            </Button>
            <Button variant="ghost" onClick={actions.cancel}>
              Cancel
            </Button>
          </div>
        </>
      );
      break;
    }
    case 'copying': {
      title = flow.retry ? 'Copying again…' : 'Copying your data…';
      const p = flow.progress;
      body = (
        <>
          <div role="status" aria-live="polite" data-testid="move-progress">
            {p ? (
              <p>
                {p.step}: {p.done} of {p.total}
              </p>
            ) : (
              <p>Starting…</p>
            )}
          </div>
          <progress className="sync-move-bar" aria-label="Copy progress" max={p?.total ?? 1} value={p ? p.done : undefined} />
          <p className="muted">Time tracking carries on while this runs, and you can keep using the app.</p>
        </>
      );
      break;
    }
    case 'done': {
      const r = flow.result;
      title = flow.retry ? 'Copy finished' : replacing ? 'Sync folder changed' : 'Folder added';
      body = (
        <>
          <p data-testid="move-summary">
            This device&apos;s data was written and checked. {copiedText(r)} The folder now holds {countsText(r.counts)}.
          </p>
          <p>
            Checked by reading the copy back. <span className="muted">Checksum {r.checksum}</span>
          </p>
          {r.sourceMissing && (
            <p className="field-warning" role="status">
              The previous folder couldn&apos;t be read, so the data on this computer was used. Use Retry copy on the new folder once the old one can be read.
            </p>
          )}
          {r.warnings.map((w) => (
            <p key={w} className="field-warning">
              {w}
            </p>
          ))}
          <div className="form-actions">
            <Button variant="primary" onClick={actions.cancel}>
              Done
            </Button>
          </div>
        </>
      );
      break;
    }
    case 'failed':
      title = 'The folder was not changed';
      body = (
        <>
          <p className="field-error" role="alert" data-testid="move-error">
            {flow.message}
          </p>
          <p>{keepLine}</p>
          <div className="form-actions">
            <Button variant="primary" onClick={actions.confirm}>
              Try again
            </Button>
            <Button variant="ghost" onClick={actions.cancel}>
              Close
            </Button>
          </div>
        </>
      );
      break;
  }

  return (
    <section className="sync-move" aria-labelledby={titleId} data-testid="sync-move">
      <h4 id={titleId} ref={heading} tabIndex={-1}>
        {title}
      </h4>
      {body}
    </section>
  );
}
