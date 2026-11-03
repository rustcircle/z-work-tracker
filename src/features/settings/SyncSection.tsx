import { useEffect, useRef, useState } from 'react';

import { useApp, useAppState } from '../../app/store';
import { api } from '../../lib/api';
import { errorMessage } from '../../lib/errorMessage';
import { parseIso } from '../../lib/tz';
import type { JoinChoice, JoinPending, SyncTargetView } from '../../lib/types';
import { ago, listOf } from '../../components/format';
import { Badge, Button, ConfirmDialog } from '../../components/ui';
import { IconRefresh } from '../../components/icons';
import { useCommands } from '../../components/useCommands';
import { bytesText } from './BackupsSection';
import { MovePanel, useSharedMoveFlow } from './MoveFlow';
import { SYNC_PRIVACY, SyncChooser, providerName } from './SyncChooser';
import { folderHealth, spanWords, whenLabel } from './syncText';
import './syncFolders.css';

/** Said once Sync is on: the lease is best effort, and the text says so. */
const ONE_AT_A_TIME =
  "Only one computer at a time can make changes. This is a best effort: cloud folders update late and can't lock anything, so two computers may both make changes for a few minutes. If that happens, nothing is lost: the changes merge.";

/** The Microsoft Store version keeps its files in a private folder that uninstalling removes. */
const PACKAGED_NO_FOLDER =
  'This copy of zWorkTracker keeps its data in a private Windows folder. Uninstalling the app deletes that folder and your hours with it. Connect a OneDrive or Google Drive folder below. Two folders are better: pick both if you use both.';
const PACKAGED_LAST_FOLDER =
  'This is the Microsoft Store version. Without a folder, your hours are kept only in a private Windows folder, and uninstalling the app deletes it.';

const headingOf = (t: SyncTargetView): string => (t.provider === 'custom' ? 'Chosen folder' : `${providerName(t.provider)} folder`);

function writtenText(t: SyncTargetView, nowSec: number): string {
  const where = t.provider === 'custom' ? 'the chosen folder' : `${providerName(t.provider)} folder`;
  return t.status.lastWrittenAt ? `Written to ${where}, ${ago(parseIso(t.status.lastWrittenAt), nowSec)}` : `Nothing written to ${where} yet`;
}

/** The first folder is the main one, the second its copy. The label only affects display, and which copy a restore tries first. */
const roleOf = (index: number): string => (index === 0 ? 'Main' : index === 1 ? 'Second copy' : `Copy ${index + 1}`);

/**
 * A folder that holds data restored from a saved version, while this computer has data from before it. Nothing is read or written there
 * until the user chooses. `destination` is a folder a move was stopped at: it is not connected, so the words say that, and what comes next.
 */
function JoinPanel({ pending, destination = false }: { pending: JoinPending; destination?: boolean }) {
  const { act, zones, snapshot } = useApp();
  const [busy, setBusy] = useState<JoinChoice | null>(null);
  const choose = (choice: JoinChoice): void => {
    setBusy(choice);
    void act(() => api.resolveJoin(pending.root, choice)).finally(() => setBusy(null));
  };
  const when = whenLabel(parseIso(pending.at), zones.active);
  // The copy of the data from before is a version in the folders that are connected, and with none there is no such copy.
  const keptIn = snapshot.sync.targets.length > 0 ? 'a safety copy on this computer and as a version in your sync folders' : 'a safety copy on this computer';
  return (
    <div className="sync-join" role="group" aria-label={destination ? 'Restored data in the folder you are moving to' : 'Restored data in this folder'} data-testid="sync-join">
      <p className="field-warning" role="status">
        {destination
          ? `This folder isn't connected yet. Its data was restored from the version of ${when} on ${pending.deviceName}, and this computer has data from before that, so the move stopped and nothing was copied. Choose what to do, then move to this folder again.`
          : `This folder's data was restored from the version of ${when} on ${pending.deviceName}. This computer has data from before that. Until you choose, nothing is read from this folder or written to it.`}
      </p>
      <div className="sync-join-choice">
        <Button disabled={busy !== null} onClick={() => choose('follow')}>
          Follow the restored data
        </Button>
        <span className="field-hint">The data on this computer is replaced by the restored data. What is here now is kept as {keptIn}.</span>
      </div>
      <div className="sync-join-choice">
        <Button disabled={busy !== null} onClick={() => choose('keep')}>
          Keep this computer&apos;s data too
        </Button>
        <span className="field-hint">This computer&apos;s data is merged into the restored data, and every computer then follows the merge. Rolled-back items may return on every computer.</span>
      </div>
    </div>
  );
}

/**
 * This computer holds the lease (design 4.4): a line here and nowhere else, and the way to let go at once. It lets go by itself after 15 minutes
 * with no change and no timer. The backend refuses while a timer runs here, and says so; the words beside the button are its own.
 */
function HeldByMe() {
  const { adopt } = useAppState();
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const release = async (): Promise<void> => {
    setBusy(true);
    setProblem(null);
    try {
      adopt(await api.leaseRelease());
    } catch (e) {
      setProblem(`Could not release: ${errorMessage(e)}`);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="sync-held" data-testid="sync-held-by-me">
      <p>
        <strong>This computer is the one making changes.</strong> It lets go by itself after 15 minutes with no change and no timer running, and when you quit. Release now lets another computer start straight away, without taking over.
      </p>
      <Button disabled={busy} onClick={() => void release()}>
        {busy ? 'Releasing…' : 'Release now'}
      </Button>
      {problem !== null && (
        <p className="field-error" role="alert">
          {problem}
        </p>
      )}
    </div>
  );
}

export function SyncSection() {
  const { snapshot, nowSec } = useApp();
  const { act } = useCommands();
  const [adding, setAdding] = useState(false);
  const [removing, setRemoving] = useState<SyncTargetView | null>(null);
  const [syncing, setSyncing] = useState(false);
  const targets = snapshot.sync.targets;
  const packaged = snapshot.platform.packaged;
  const unreachable = new Set(snapshot.lease.unreachableRoots);
  const joinPending = snapshot.sync.joinPending ?? null;
  // A move into a folder past a restore is stopped with the question left on the destination, which is not connected, so no folder in the list can show it.
  const askedOfDestination = joinPending !== null && !targets.some((t) => t.root === joinPending.root) ? joinPending : null;
  const root = useRef<HTMLDivElement | null>(null);
  const move = useSharedMoveFlow();
  const { attach } = move;
  useEffect(() => {
    attach(root.current);
    return () => attach(null);
  }, [attach]);
  const pending = snapshot.sync.pendingCopy;
  const copying = move.flow.phase === 'copying';
  // Each folder is judged on its own. One failing must be seen, and must not read as the other one failing too.
  const failing = targets.filter((t) => folderHealth(t, unreachable.has(t.root)).label === 'Problem');
  const carryingOn = targets.filter((t) => !failing.includes(t));
  const nameList = (list: SyncTargetView[]): string => listOf(list.map((t) => headingOf(t)));

  return (
    <div className="settings-stack" ref={root}>
      <p className="sync-privacy">{SYNC_PRIVACY}</p>
      <p className="field-hint" data-testid="sync-when">
        Once a folder is connected, sync runs by itself: shortly after each major action (such as starting, pausing or stopping a task), shortly after text edits settle, every 30 minutes, when the app starts and when it quits. A failed attempt is retried after a wait that grows each time.
      </p>
      {targets.length > 0 && (
        <p className="field-hint" data-testid="sync-one-at-a-time">
          {ONE_AT_A_TIME}
        </p>
      )}
      {snapshot.lease.state === 'heldByMe' && <HeldByMe />}
      {targets.length === 0 ? (
        <>
          {packaged && (
            <p className="sync-packaged field-warning" data-testid="packaged-no-folder">
              <strong>Choose a cloud folder.</strong> {PACKAGED_NO_FOLDER}
            </p>
          )}
          <p className="muted">Sync is off. This device keeps its data only on this computer.</p>
        </>
      ) : (
        <>
          {failing.length > 0 && carryingOn.length > 0 && (
            <p className="field-hint" role="status" data-testid="sync-one-failing">
              {nameList(failing)} {failing.length === 1 ? 'has' : 'have'} a problem. {nameList(carryingOn)} carries on, so your data keeps syncing there.
            </p>
          )}
          {failing.length === targets.length && targets.length > 1 && (
            <p className="field-warning" role="status" data-testid="sync-all-failing">
              No folder is working right now. Your data is safe on this computer, and syncing carries on when a folder works again.
            </p>
          )}
          <ul className="sync-targets" aria-label="Sync folders">
            {targets.map((t, i) => {
              const cannotRead = unreachable.has(t.root);
              const health = folderHealth(t, cannotRead);
              const s = t.status;
              const versionParts = [s.lastVersionAt ? `Last version saved here ${ago(parseIso(s.lastVersionAt), nowSec)}` : null, typeof s.versionsBytes === 'number' ? `Saved versions here take ${bytesText(s.versionsBytes)}` : null].filter((x) => x !== null);
              return (
                <li key={t.root} className="sync-target" data-testid="sync-target" data-root={t.root}>
                  <div className="sync-target-head">
                    <div>
                      <h4>{headingOf(t)}</h4>
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
                  <div className="sync-target-tags">
                    {targets.length > 1 && <Badge title={i === 0 ? 'Sync and a restore use this folder first' : 'A second copy of the same data'}>{roleOf(i)}</Badge>}
                    <Badge tone={health.tone} title={health.label === 'Problem' ? 'This folder has a problem. The details are below.' : undefined}>
                      {health.label}
                    </Badge>
                  </div>
                  {joinPending && joinPending.root === t.root && <JoinPanel pending={joinPending} />}
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
                    {s.lastReadAt ? `Other devices' changes read ${ago(parseIso(s.lastReadAt), nowSec)}` : "Other devices' changes not read yet"} · {s.devicesSeen} other {s.devicesSeen === 1 ? 'device' : 'devices'} seen
                    {s.ignoredFiles > 0 && ` · ${s.ignoredFiles} unreadable ${s.ignoredFiles === 1 ? 'file' : 'files'} ignored`}
                  </p>
                  {versionParts.length > 0 && (
                    <p className="muted" data-testid="sync-versions">
                      {versionParts.join('. ')}.
                    </p>
                  )}
                  {s.lastLeaseAt && (
                    <p className="muted" data-testid="sync-lease-at">
                      The note about which computer is in use was written here {ago(parseIso(s.lastLeaseAt), nowSec)}.
                    </p>
                  )}
                  {typeof s.lagSecs === 'number' && s.lagSecs > 0 && (
                    <p className="field-warning" role="status" data-testid="sync-lag">
                      This folder&apos;s copy of another computer&apos;s data is {spanWords(s.lagSecs)} behind the other folder. Its cloud app may be paused.
                    </p>
                  )}
                  <p className="field-hint">This app only writes the files. Your sync app uploads them, and this app cannot confirm that it has.</p>
                  {s.warnings.map((w) => (
                    <p key={w} className="field-warning" role="status">
                      {w}
                    </p>
                  ))}
                  {cannotRead && !s.lastError && (
                    <p className="field-error" role="alert" data-testid="sync-unreachable">
                      This folder can&apos;t be read right now. Is the drive connected and the desktop client running?
                    </p>
                  )}
                  {s.lastError && (
                    <p className="field-error" role="alert">
                      Last error{s.lastErrorAt ? ` (${ago(parseIso(s.lastErrorAt), nowSec)})` : ''}: {s.lastError}
                    </p>
                  )}
                  {s.leaseError && (
                    <p className="field-error" role="alert" data-testid="sync-lease-error">
                      The note about which computer is in use couldn&apos;t be written here: {s.leaseError}
                    </p>
                  )}
                  {s.lastVersionError && (
                    <p className="field-error" role="alert" data-testid="sync-version-error">
                      A version couldn&apos;t be saved in this folder: {s.lastVersionError}
                    </p>
                  )}
                </li>
              );
            })}
          </ul>
          {targets.length === 1 && <p className="field-hint">A second folder keeps a working copy in each. If one has a problem, the other carries on.</p>}
        </>
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
        {targets.length < 2 && (
          <Button
            aria-expanded={targets.length === 0 ? adding : move.flow.phase === 'choose' && !move.flow.replacing}
            disabled={move.busy && targets.length > 0}
            onClick={() => {
              const first = targets[0];
              if (first) move.begin(first.root, false);
              else setAdding((v) => !v);
            }}
          >
            {targets.length === 0 ? 'Add a folder' : 'Add a second folder'}
          </Button>
        )}
      </div>
      <MovePanel actions={move} detected={snapshot.sync.detected} existing={targets.map((t) => t.root)} />
      {askedOfDestination && (
        <div className="sync-target" data-testid="sync-join-destination">
          <h4>The folder you are moving to</h4>
          <p className="muted sync-path">{askedOfDestination.root}</p>
          <JoinPanel pending={askedOfDestination} destination />
        </div>
      )}
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
        {removing !== null && targets.length > 1 && removing.root === targets[0]?.root && <p>The other folder becomes the main one.</p>}
        {packaged && targets.length === 1 && (
          <p className="field-warning" data-testid="remove-last-folder">
            {PACKAGED_LAST_FOLDER}
          </p>
        )}
      </ConfirmDialog>
    </div>
  );
}
