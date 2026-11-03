// Saved versions of the data, kept in the sync folders: browse them, read what changed in each, and restore one. Any computer can
// restore from them, and a version stays in the folders when the app is uninstalled. A folder that can't be read costs only its own copies.
import { useEffect, useId, useState } from 'react';

import { useAppState } from '../../app/store';
import { useReadOnly } from '../../app/useReadOnly';
import { api } from '../../lib/api';
import { errorMessage } from '../../lib/errorMessage';
import { dayOf, parseIso } from '../../lib/tz';
import type { RestorePreview, VersionInfo, VersionList, VersionLocation } from '../../lib/types';
import { IconFolder, IconRefresh, IconRestore } from '../../components/icons';
import { useOptionalNav } from '../../components/nav';
import { Badge, Button, Modal } from '../../components/ui';
import { bytesText } from './BackupsSection';
import { countsText } from './MoveFlow';
import { folderName, whenLabel } from './syncText';
import { capitalize, versionReasonWords } from './versionText';
import './p2time.css';
import './versions.css';

type Load = { status: 'loading' } | { status: 'error'; message: string } | { status: 'ready'; list: VersionList };
type Outcome<T> = { ok: true; value: T } | { ok: false; message: string };
/** What a read of one copy came to. `key` says which read it is the answer to, so an older answer is never taken for a newer one. */
interface Read<T> {
  key: string;
  outcome: Outcome<T>;
}

const NO_VERSIONS: VersionList = { versions: [], errors: [], totalBytes: 0, overBudget: false };

/** What a restore does, said at its second step. With no folder connected it is a restore on this computer alone: the backend saves the copy of today's data here only, and no other computer follows. */
const RESTORE_WITH_FOLDERS =
  "This replaces the data on every computer that syncs with these folders. First, a copy of today's data is saved here and in your folders, so you can undo this by restoring that copy. A running task is paused. Changes from a computer on an older app version are skipped until it is updated, so update every computer first.";
const RESTORE_WITH_NO_FOLDER = "This replaces the data on this computer. First, a copy of today's data is saved on this computer (Settings, Backups), so you can undo this by restoring that copy. A running task is paused.";
const LONG_MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'] as const;

/** "March 2026", for a month key like "2026-03". */
export function monthTitle(key: string): string {
  const [year, month] = key.split('-');
  return `${LONG_MONTHS[Number(month) - 1] ?? key} ${year ?? ''}`.trim();
}

/** The versions by month of the day they were taken on in `zone`, newest first. */
export function groupByMonth(versions: readonly VersionInfo[], zone: string): { key: string; title: string; items: VersionInfo[] }[] {
  const sorted = [...versions].sort((a, b) => (a.takenAt < b.takenAt ? 1 : a.takenAt > b.takenAt ? -1 : a.name < b.name ? 1 : -1));
  const groups: { key: string; title: string; items: VersionInfo[] }[] = [];
  for (const v of sorted) {
    const key = dayOf(parseIso(v.takenAt), zone).slice(0, 7);
    const last = groups[groups.length - 1];
    if (last && last.key === key) last.items.push(v);
    else groups.push({ key, title: monthTitle(key), items: [v] });
  }
  return groups;
}

/**
 * What to say about a copy that can't be read, and which copy to try instead: one that holds the same version and hasn't failed.
 * A copy is often just still syncing, so nothing here calls it damaged.
 */
export function unreadable(locations: readonly VersionLocation[], failed: ReadonlySet<string>, root: string): { text: string; alternative: VersionLocation | null } {
  const alternative = locations.find((l) => l.root !== root && !failed.has(l.root)) ?? null;
  if (alternative) return { text: `This copy isn't readable here (it may still be syncing). Try the copy in ${folderName(alternative.provider, alternative.root)}.`, alternative };
  if (locations.length > 1) return { text: 'None of the copies of this version can be read here right now. They may still be syncing.', alternative: null };
  return { text: "This copy isn't readable here (it may still be syncing). Try again in a few minutes.", alternative: null };
}

function Unreadable({ locations, failed, root, detail, onUse, onRetry }: { locations: readonly VersionLocation[]; failed: ReadonlySet<string>; root: string; detail: string; onUse: (root: string) => void; onRetry: () => void }) {
  const { text, alternative } = unreadable(locations, failed, root);
  return (
    <div className="sv-problem" data-testid="version-unreadable">
      <p className="field-error" role="alert">
        {text}
      </p>
      {alternative ? (
        <Button small onClick={() => onUse(alternative.root)}>
          Use the copy in {folderName(alternative.provider, alternative.root)}
        </Button>
      ) : (
        <Button small onClick={onRetry}>
          Try again
        </Button>
      )}
      {detail !== '' && <p className="field-hint">Details: {detail}</p>}
    </div>
  );
}

const PinMark = () => (
  <svg className="sv-pin" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M9 4h6l-1 6 3 3H7l3-3zM12 13v7" />
  </svg>
);

/** The folders holding a version. With more than one, each is a choice of the copy to read, and the chosen one is marked. */
function Copies({ locations, root, onChoose }: { locations: readonly VersionLocation[]; root: string; onChoose: (root: string) => void }) {
  const [only, ...others] = locations;
  if (only && others.length === 0) {
    return (
      <span className="sv-copies">
        <Badge title={only.root}>{folderName(only.provider, only.root)}</Badge>
      </span>
    );
  }
  return (
    <span className="sv-copies" role="group" aria-label="Copies of this version. The one pressed is the one read.">
      {locations.map((l) => (
        <button key={l.root} type="button" className="badge badge-button" aria-pressed={l.root === root} title={`${l.root} (${bytesText(l.bytes)})`} onClick={() => onChoose(l.root)}>
          {folderName(l.provider, l.root)}
        </button>
      ))}
    </span>
  );
}

function VersionRow({ v, zone, readOnly, onRestore }: { v: VersionInfo; zone: string; readOnly: boolean; onRestore: (v: VersionInfo, root: string) => void }) {
  const when = whenLabel(parseIso(v.takenAt), zone);
  const [source, setSource] = useState(v.locations[0]?.root ?? '');
  // The copy in use is one the version is still in, whatever happened to the folders since it was picked.
  const root = v.locations.some((l) => l.root === source) ? source : (v.locations[0]?.root ?? '');
  const [open, setOpen] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [failed, setFailed] = useState<ReadonlySet<string>>(new Set());
  const [read, setRead] = useState<Read<string> | null>(null);
  const panelId = useId();
  const key = `${root}|${attempt}`;

  useEffect(() => {
    if (!open || root === '') return undefined;
    let alive = true;
    api.readVersionChanges(root, v.name).then(
      (text) => {
        if (alive) setRead({ key, outcome: { ok: true, value: text } });
      },
      (e: unknown) => {
        if (!alive) return;
        setFailed((f) => new Set(f).add(root));
        setRead({ key, outcome: { ok: false, message: errorMessage(e) } });
      },
    );
    return () => {
      alive = false;
    };
  }, [open, root, key, v.name]);

  const current = read !== null && read.key === key ? read.outcome : null;
  const size = Math.max(0, ...v.locations.map((l) => l.bytes));
  return (
    <li className="sv-row" data-testid="version-row" data-name={v.name}>
      <div className="sv-main">
        <time className="sv-when" dateTime={v.takenAt}>
          {when}
        </time>
        <span>{capitalize(versionReasonWords(v.reason))}</span>
        <span className="muted">Saved by {v.deviceName}</span>
        <span className="muted tabular">{bytesText(size)}</span>
        {v.pinned && (
          <Badge tone="accent" title="Kept for a year, whatever the retention rule says">
            <PinMark />
            Kept for a year
          </Badge>
        )}
        {v.locations.length > 0 && <Copies locations={v.locations} root={root} onChoose={setSource} />}
      </div>
      <div className="sv-actions">
        <Button small aria-expanded={open} aria-controls={panelId} disabled={v.locations.length === 0} onClick={() => setOpen((o) => !o)}>
          What changed <span className="visually-hidden">in the version from {when}</span>
        </Button>
        <Button small icon={<IconRestore />} aria-label={`Restore the version from ${when}`} title={readOnly ? 'Take over first to restore.' : undefined} disabled={readOnly || v.locations.length === 0} onClick={() => onRestore(v, root)}>
          Restore…
        </Button>
      </div>
      <div id={panelId} hidden={!open}>
        {open && current === null && <p className="muted">Reading what changed…</p>}
        {open && current?.ok === true && (
          <pre className="sv-changes" tabIndex={0} aria-label={`What changed in the version from ${when}`} data-testid="version-changes">
            {current.value}
          </pre>
        )}
        {open && current?.ok === false && (
          <Unreadable
            locations={v.locations}
            failed={failed}
            root={root}
            detail={current.message}
            onUse={setSource}
            onRetry={() => {
              setFailed(new Set());
              setAttempt((a) => a + 1);
            }}
          />
        )}
      </div>
    </li>
  );
}

/** Two steps: what the version holds against what is here, then what restoring does. Nothing is sent until the second. */
function RestoreDialog({ version, initialRoot, zone, onClose, onRestored }: { version: VersionInfo; initialRoot: string; zone: string; onClose: () => void; onRestored: () => void }) {
  const { adopt, snapshot } = useAppState();
  const when = whenLabel(parseIso(version.takenAt), zone);
  const [step, setStep] = useState<1 | 2>(1);
  const [root, setRoot] = useState(initialRoot);
  const [attempt, setAttempt] = useState(0);
  const [failed, setFailed] = useState<ReadonlySet<string>>(new Set());
  const [read, setRead] = useState<Read<RestorePreview> | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const backId = useId();
  const key = `${root}|${attempt}`;

  useEffect(() => {
    let alive = true;
    api.previewRestoreVersion(root, version.name).then(
      (preview) => {
        if (alive) setRead({ key, outcome: { ok: true, value: preview } });
      },
      (e: unknown) => {
        if (!alive) return;
        setFailed((f) => new Set(f).add(root));
        setRead({ key, outcome: { ok: false, message: errorMessage(e) } });
      },
    );
    return () => {
      alive = false;
    };
  }, [root, key, version.name]);

  // Going on to the second step takes the focus along, to the safe button.
  useEffect(() => {
    if (step === 2) document.getElementById(backId)?.focus();
  }, [step, backId]);

  const current = read !== null && read.key === key ? read.outcome : null;
  const preview = current?.ok === true ? current.value : null;
  const blocked = preview?.blockedReason ?? null;

  const restore = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      adopt(await api.restoreVersion(root, version.name));
      onRestored();
    } catch (e) {
      setError(errorMessage(e));
      setBusy(false);
    }
  };

  return (
    <Modal
      open
      title="Restore this version?"
      onClose={onClose}
      dismissible={!busy}
      footer={
        step === 1 ? (
          <>
            <Button data-autofocus onClick={onClose}>
              Cancel
            </Button>
            <Button variant="primary" disabled={preview === null || blocked !== null} onClick={() => setStep(2)}>
              Continue
            </Button>
          </>
        ) : (
          <>
            <Button id={backId} disabled={busy} onClick={() => setStep(1)}>
              Back
            </Button>
            <Button variant="danger" disabled={busy} onClick={() => void restore()}>
              Restore this version
            </Button>
          </>
        )
      }
    >
      <p className="sv-step">Step {step} of 2</p>
      <p>
        <strong>The version from {when}</strong>
      </p>
      <p className="muted" data-testid="restore-which">
        {capitalize(versionReasonWords(version.reason))}, from {version.deviceName}.
      </p>
      {step === 1 && (
        <>
          {version.locations.length > 1 && (
            <fieldset className="sv-sources">
              <legend>Restore from</legend>
              {version.locations.map((l) => (
                <label key={l.root} className="check">
                  <input type="radio" name={`${backId}-from`} checked={root === l.root} onChange={() => setRoot(l.root)} /> {folderName(l.provider, l.root)}
                </label>
              ))}
            </fieldset>
          )}
          {current === null && <p className="muted">Looking inside the version…</p>}
          {current?.ok === false && (
            <Unreadable
              locations={version.locations}
              failed={failed}
              root={root}
              detail={current.message}
              onUse={setRoot}
              onRetry={() => {
                setFailed(new Set());
                setAttempt((a) => a + 1);
              }}
            />
          )}
          {preview && (
            <>
              <dl className="sv-counts" data-testid="restore-counts">
                <dt>This version</dt>
                <dd data-testid="restore-version-counts">{countsText(preview.version)}</dd>
                <dt>On this computer now</dt>
                <dd data-testid="restore-current-counts">{countsText(preview.current)}</dd>
              </dl>
              {preview.warnings.length > 0 && (
                <div data-testid="restore-warnings">
                  <p className="field-warning">These records couldn&apos;t be read, so a restore leaves them out:</p>
                  <ul className="plain-list">
                    {preview.warnings.map((w) => (
                      <li key={w}>{w}</li>
                    ))}
                  </ul>
                </div>
              )}
              {blocked !== null && (
                <p className="field-error" role="alert" data-testid="restore-blocked">
                  {blocked}
                </p>
              )}
            </>
          )}
        </>
      )}
      {step === 2 && (
        <>
          <p>{snapshot.sync.targets.length > 0 ? RESTORE_WITH_FOLDERS : RESTORE_WITH_NO_FOLDER}</p>
          {error && (
            <p className="field-error" role="alert" data-testid="restore-error">
              {error}
            </p>
          )}
        </>
      )}
    </Modal>
  );
}

export function VersionsSection() {
  const { snapshot, zones, adopt } = useAppState();
  const { readOnly, why } = useReadOnly();
  const nav = useOptionalNav();
  const targets = snapshot.sync.targets;
  const [load, setLoad] = useState<Load>({ status: 'loading' });
  const [extraRoot, setExtraRoot] = useState<string | null>(null);
  const [restoring, setRestoring] = useState<{ version: VersionInfo; root: string } | null>(null);
  const [saving, setSaving] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);
  const zone = zones.active;
  const nothingToLookIn = targets.length === 0 && extraRoot === null;
  // A folder looked in by hand may be one that is connected, and the backend lists it once.
  const foldersLookedIn = new Set([...targets.map((t) => t.root), ...(extraRoot === null ? [] : [extraRoot])]).size;
  // A folder writing or pruning a version changes these, and that is how the list hears of it.
  const written = targets.map((t) => `${t.root}|${t.status.lastVersionAt ?? ''}|${t.status.versionsBytes ?? ''}`).join(';');
  const [nonce, setNonce] = useState(0);

  async function fetchList(): Promise<Load> {
    try {
      return { status: 'ready', list: await api.listVersions(extraRoot ?? undefined) };
    } catch (e) {
      return { status: 'error', message: errorMessage(e) };
    }
  }

  useEffect(() => {
    if (nothingToLookIn) return undefined;
    let alive = true;
    api.listVersions(extraRoot ?? undefined).then(
      (list) => {
        if (alive) setLoad({ status: 'ready', list });
      },
      (e: unknown) => {
        if (alive) setLoad({ status: 'error', message: errorMessage(e) });
      },
    );
    return () => {
      alive = false;
    };
  }, [nothingToLookIn, extraRoot, written, nonce]);

  const shown: Load = nothingToLookIn ? { status: 'ready', list: NO_VERSIONS } : load;
  const list = shown.status === 'ready' ? shown.list : null;
  const rootName = (root: string): string => {
    const t = targets.find((x) => x.root === root);
    return folderName(t?.provider ?? 'custom', root);
  };

  async function saveNow(): Promise<void> {
    setSaving(true);
    setResult(null);
    const newest = list?.versions[0]?.name ?? null;
    try {
      adopt(await api.saveVersionNow());
      const next = await fetchList();
      setLoad(next);
      const latest = next.status === 'ready' ? (next.list.versions[0]?.name ?? null) : null;
      setResult(latest !== null && latest !== newest ? { ok: true, text: 'A version was saved.' } : { ok: true, text: 'No new version has appeared in the list yet. Look again in a moment.' });
    } catch (e) {
      setResult({ ok: false, text: `Could not save a version: ${errorMessage(e)}` });
    } finally {
      setSaving(false);
    }
  }

  async function lookElsewhere(): Promise<void> {
    const picked = await api.pickSyncFolder().catch(() => null);
    if (picked) setExtraRoot(picked);
  }

  const groups = list ? groupByMonth(list.versions, zone) : [];
  return (
    <div className="settings-stack">
      <p>Saved copies of your data in your sync folders. Any computer can restore from them, and uninstalling the app doesn&apos;t touch them.</p>
      <p className="field-hint" data-testid="versions-how">
        The computer that is making changes saves a copy after your data changes, normally at most once an hour. It also saves one when you close the app after changes, when you save one by hand, and around a restore or a take over. Every copy is kept for 7 days, then one a day for 60 days, then one a month. Copies made around a restore or a take over are kept for a year. OneDrive and Google Drive can also keep earlier copies of each file (Version history in OneDrive, Manage versions in Google Drive). That stays available too, as a second safety net.
      </p>
      {readOnly && (
        <p className="field-warning" role="status" data-testid="versions-read-only">
          Take over first to restore or save a version. {why}
        </p>
      )}
      <div className="inline-actions">
        {targets.length > 0 && (
          <Button variant="primary" disabled={readOnly || saving} onClick={() => void saveNow()}>
            {saving ? 'Saving…' : 'Save a version now'}
          </Button>
        )}
        <Button icon={<IconFolder />} onClick={() => void lookElsewhere()}>
          Look in another folder…
        </Button>
        {!nothingToLookIn && (
          <Button icon={<IconRefresh />} onClick={() => setNonce((n) => n + 1)}>
            Look again
          </Button>
        )}
      </div>
      {extraRoot !== null && (
        <p className="muted" data-testid="versions-extra">
          Also looking in {extraRoot}.{' '}
          <Button small variant="ghost" onClick={() => setExtraRoot(null)}>
            Stop looking there
          </Button>
        </p>
      )}
      <div aria-live="polite">
        {result && (
          <p className={result.ok ? 'backup-result' : 'field-error'} role={result.ok ? 'status' : 'alert'} data-testid="versions-result">
            {result.text}
          </p>
        )}
      </div>
      {nothingToLookIn && (
        <p className="muted" data-testid="versions-no-folder">
          Versions are saved in your sync folders, and none is connected.{' '}
          {nav && (
            <Button small variant="ghost" onClick={() => nav.openSettings('sync')}>
              Connect a folder
            </Button>
          )}{' '}
          Use Look in another folder if an earlier folder still holds versions.
        </p>
      )}
      {shown.status === 'loading' && <p className="muted">Looking for versions…</p>}
      {shown.status === 'error' && (
        <p className="field-error" role="alert">
          Could not list the versions: {shown.message}
        </p>
      )}
      {list?.errors.map((e) => (
        <p key={e.root} className="field-error" role="alert" data-testid="versions-folder-error">
          Couldn&apos;t look for versions in {rootName(e.root)}: {e.message}
          {list.versions.length > 0 ? ' The versions found in the other folders are listed.' : ''}
        </p>
      ))}
      {list && list.versions.length === 0 && !nothingToLookIn && list.errors.length < foldersLookedIn && (
        <p className="muted" data-testid="versions-empty">
          No versions yet. A copy is saved after your data changes, normally at most once an hour. Save a version now makes one at once.
        </p>
      )}
      {list && list.versions.length > 0 && (
        <>
          <p className="muted" data-testid="versions-total">
            {list.versions.length} {list.versions.length === 1 ? 'version' : 'versions'}, newest first. Together the copies take {bytesText(list.totalBytes)} in your folders.
          </p>
          {list.overBudget && (
            <p className="field-warning" role="status" data-testid="versions-over-budget">
              The saved versions take more than 1 GB in total. Nothing is deleted because of that.
            </p>
          )}
          {groups.map((g) => (
            <div key={g.key} className="settings-stack">
              <h4 className="sv-month">{g.title}</h4>
              <ul className="sv-list" aria-label={`Versions from ${g.title}`}>
                {g.items.map((v) => (
                  <VersionRow key={v.name} v={v} zone={zone} readOnly={readOnly} onRestore={(version, root) => setRestoring({ version, root })} />
                ))}
              </ul>
            </div>
          ))}
        </>
      )}
      {restoring && (
        <RestoreDialog
          version={restoring.version}
          initialRoot={restoring.root}
          zone={zone}
          onClose={() => setRestoring(null)}
          onRestored={() => {
            const when = whenLabel(parseIso(restoring.version.takenAt), zone);
            setRestoring(null);
            setResult({ ok: true, text: `Restored the version from ${when}. The notices at the top of the window say what to expect.` });
            void fetchList().then(setLoad);
          }}
        />
      )}
    </div>
  );
}
