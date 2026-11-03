import { useEffect, useState } from 'react';

import { useAppState } from '../../app/store';
import { useReadOnly } from '../../app/useReadOnly';
import { api } from '../../lib/api';
import { TZDB_VERSION } from '../../lib/tz';
import { version as APP_VERSION } from '../../../package.json';
import type { AutostartInfo, AutostartState } from '../../lib/types';
import { Button, Field, Switch } from '../../components/ui';
import { useCommands } from '../../components/useCommands';
import { ZoneDataAttribution } from '../zones';
import { errorMessage } from '../../lib/errorMessage';
import { ReadOnlyNote } from './ReadOnlyNote';

function parseHours(text: string): { ok: true; value: number | null } | { ok: false } {
  const t = text.trim();
  if (t === '') return { ok: true, value: null };
  const n = Number(t.replace(',', '.'));
  return Number.isFinite(n) && n > 0 && n <= 168 ? { ok: true, value: n } : { ok: false };
}

export function TargetsSection() {
  const { snapshot } = useAppState();
  const { act } = useCommands();
  const s = snapshot.settings;
  const { readOnly } = useReadOnly();
  // What is typed, or null while a field just shows the stored value, which can change from elsewhere.
  const [dailyDraft, setDaily] = useState<string | null>(null);
  const [weeklyDraft, setWeekly] = useState<string | null>(null);
  const daily = dailyDraft ?? (s.dailyTargetHours != null ? String(s.dailyTargetHours) : '');
  const weekly = weeklyDraft ?? (s.weeklyTargetHours != null ? String(s.weeklyTargetHours) : '');
  const d = parseHours(daily);
  const w = parseHours(weekly);
  return (
    <form
      className="settings-stack"
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        if (!d.ok || !w.ok || readOnly) return;
        void act(() => api.setSetting('dailyTargetHours', d.value))
          .then((ok) => ok && act(() => api.setSetting('weeklyTargetHours', w.value)))
          .then((ok) => {
            if (!ok) return;
            setDaily(null);
            setWeekly(null);
          });
      }}
    >
      <ReadOnlyNote />
      <p>Optional goals for the analysis tab. Leave a field blank to turn that goal off. Targets measure logged time only.</p>
      <div className="row-fields">
        <Field label="Daily target (hours)" error={d.ok ? null : 'Enter hours between 0 and 168, like 6.5.'}>
          {({ id, describedBy }) => <input id={id} className="input input-narrow" inputMode="decimal" value={daily} onChange={(e) => setDaily(e.target.value)} aria-describedby={describedBy} placeholder="off" disabled={readOnly} />}
        </Field>
        <Field label="Weekly target (hours)" error={w.ok ? null : 'Enter hours between 0 and 168, like 30.'}>
          {({ id, describedBy }) => <input id={id} className="input input-narrow" inputMode="decimal" value={weekly} onChange={(e) => setWeekly(e.target.value)} aria-describedby={describedBy} placeholder="off" disabled={readOnly} />}
        </Field>
      </div>
      <div className="form-actions">
        <Button variant="primary" type="submit" disabled={!d.ok || !w.ok || readOnly}>
          Save targets
        </Button>
      </div>
    </form>
  );
}

/**
 * What to tell the user when Windows won't let the switch move, in the backend's words (`AutostartInfo.note` carries the same).
 * Used when a note is missing, so a state that needs a word never goes without one.
 */
const AUTOSTART_TEXT: Record<AutostartState, string | null> = {
  on: null,
  off: null,
  offByUser: 'You turned this off in Windows, so only Windows can turn it back on: Settings > Apps > Startup.',
  offByPolicy: "A policy on this computer doesn't allow this, or the device doesn't support it.",
  onByPolicy: 'A policy on this computer keeps this on.',
  unavailable: "Windows couldn't find this app's startup entry.",
};

export function AutostartSection() {
  const { showError } = useAppState();
  const [info, setInfo] = useState<AutostartInfo | null>(null);
  const [unreadable, setUnreadable] = useState(false);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let alive = true;
    api.getAutostartInfo().then(
      (v) => alive && setInfo(v),
      () => alive && setUnreadable(true),
    );
    return () => {
      alive = false;
    };
  }, []);

  const change = async (enabled: boolean): Promise<void> => {
    setBusy(true);
    try {
      await api.setAutostart(enabled);
    } catch (e) {
      showError(errorMessage(e));
    }
    // Windows has the last word, so the switch shows what it says now and not what was asked for.
    try {
      setInfo(await api.getAutostartInfo());
    } catch {
      // The switch keeps what it showed.
    }
    setBusy(false);
  };

  const openStartupSettings = async (): Promise<void> => {
    try {
      await api.openStartupSettings();
    } catch (e) {
      showError(errorMessage(e));
    }
  };

  const state = info?.state ?? 'off';
  const note = info === null ? null : (info.note ?? AUTOSTART_TEXT[info.state]);
  return (
    <div className="settings-stack">
      <Switch
        label="Start zWorkTracker when I sign in to Windows"
        hint="Off by default. When it is on, zWorkTracker opens when you sign in to Windows."
        checked={state === 'on' || state === 'onByPolicy'}
        disabled={info === null || !info.canChange || busy}
        onChange={(v) => void change(v)}
      />
      {unreadable && (
        <p className="field-error" role="alert">
          Couldn&apos;t find out whether this is on.
        </p>
      )}
      {info?.packaged && <p className="field-hint">This is the Microsoft Store version, so Windows has the last word on this switch.</p>}
      {note && (
        <p className="field-hint" role="status" data-testid="autostart-note">
          {note}
        </p>
      )}
      {info?.state === 'offByUser' && (
        <div>
          <Button small onClick={() => void openStartupSettings()}>
            Open Startup settings
          </Button>
        </div>
      )}
    </div>
  );
}

export function AboutSection() {
  const { snapshot } = useAppState();
  return (
    <div className="settings-stack">
      <dl className="kv-list">
        <div>
          <dt>App version</dt>
          <dd data-testid="app-version">{APP_VERSION}</dd>
        </div>
        <div>
          <dt>Time zone data (bundled in this app)</dt>
          <dd data-testid="tzdb-ui">{TZDB_VERSION}</dd>
        </div>
        <div>
          <dt>Time zone data (backend)</dt>
          <dd data-testid="tzdb-backend">{snapshot.tzdbVersion}</dd>
        </div>
        <div>
          <dt>This device</dt>
          <dd>{snapshot.deviceName}</dd>
        </div>
      </dl>
      <p>
        Time zone rules ship inside the app. When governments change daylight saving rules, the fix arrives with an app update, so keep the app up to date for correct hours on future dates. Past dates keep the offsets they had.
      </p>
      <p>This app collects no telemetry and makes no network requests of its own. Time you log stays on this computer unless you turn on sync.</p>
      <ZoneDataAttribution />
    </div>
  );
}
