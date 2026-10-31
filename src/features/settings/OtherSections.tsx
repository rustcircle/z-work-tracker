import { useEffect, useState } from 'react';

import { useApp } from '../../app/store';
import { api } from '../../lib/api';
import { TZDB_VERSION } from '../../lib/tz';
import { version as APP_VERSION } from '../../../package.json';
import { Button, Field, Switch } from '../../components/ui';
import { useCommands } from '../../components/useCommands';
import { ZoneDataAttribution } from '../zones';
import { errorMessage } from '../../lib/errorMessage';

function parseHours(text: string): { ok: true; value: number | null } | { ok: false } {
  const t = text.trim();
  if (t === '') return { ok: true, value: null };
  const n = Number(t.replace(',', '.'));
  return Number.isFinite(n) && n > 0 && n <= 168 ? { ok: true, value: n } : { ok: false };
}

export function TargetsSection() {
  const { snapshot } = useApp();
  const { act } = useCommands();
  const s = snapshot.settings;
  const [daily, setDaily] = useState(s.dailyTargetHours != null ? String(s.dailyTargetHours) : '');
  const [weekly, setWeekly] = useState(s.weeklyTargetHours != null ? String(s.weeklyTargetHours) : '');
  const d = parseHours(daily);
  const w = parseHours(weekly);
  return (
    <form
      className="settings-stack"
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        if (!d.ok || !w.ok) return;
        void act(() => api.setSetting('dailyTargetHours', d.value)).then((ok) => ok && act(() => api.setSetting('weeklyTargetHours', w.value)));
      }}
    >
      <p>Optional goals for the analysis tab. Leave a field blank to turn that goal off. Targets measure logged time only.</p>
      <div className="row-fields">
        <Field label="Daily target (hours)" error={d.ok ? null : 'Enter hours between 0 and 168, like 6.5.'}>
          {({ id, describedBy }) => <input id={id} className="input input-narrow" inputMode="decimal" value={daily} onChange={(e) => setDaily(e.target.value)} aria-describedby={describedBy} placeholder="off" />}
        </Field>
        <Field label="Weekly target (hours)" error={w.ok ? null : 'Enter hours between 0 and 168, like 30.'}>
          {({ id, describedBy }) => <input id={id} className="input input-narrow" inputMode="decimal" value={weekly} onChange={(e) => setWeekly(e.target.value)} aria-describedby={describedBy} placeholder="off" />}
        </Field>
      </div>
      <div className="form-actions">
        <Button variant="primary" type="submit" disabled={!d.ok || !w.ok}>
          Save targets
        </Button>
      </div>
    </form>
  );
}

export function AutostartSection() {
  const { showError } = useApp();
  const [on, setOn] = useState<boolean | null>(null);
  useEffect(() => {
    let alive = true;
    api.getAutostart().then(
      (v) => alive && setOn(v),
      () => alive && setOn(false),
    );
    return () => {
      alive = false;
    };
  }, []);
  return (
    <Switch
      label="Start zWorkTracker when I sign in to Windows"
      hint="Off by default. It starts hidden in the system tray."
      checked={on === true}
      disabled={on === null}
      onChange={(v) => {
        setOn(v);
        api.setAutostart(v).then(setOn, (e: unknown) => {
          setOn(!v);
          showError(errorMessage(e));
        });
      }}
    />
  );
}

export function AboutSection() {
  const { snapshot } = useApp();
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
