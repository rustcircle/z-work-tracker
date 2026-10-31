// Idle minutes, long-run minutes and remind past shift end. Whole minutes, 0 to 10080; 0 turns one off.
// The backend sends the system notification; the window shows the same reminder as a banner.
import { useState } from 'react';

import { useAppState } from '../../app/store';
import { api } from '../../lib/api';
import { Button, Field, Switch } from '../../components/ui';
import { plural } from '../../components/format';
import './p2time.css';
import { errorMessage } from '../../lib/errorMessage';

export const MAX_MINUTES = 10_080;

/** The minutes in `text`, or an explanation of what is wrong with it. */
export function parseMinutes(text: string): { ok: true; minutes: number } | { ok: false; message: string } {
  const t = text.trim();
  if (!/^\d+$/.test(t)) return { ok: false, message: `Enter whole minutes from 0 to ${MAX_MINUTES}.` };
  const minutes = Number(t);
  if (minutes > MAX_MINUTES) return { ok: false, message: `Enter whole minutes from 0 to ${MAX_MINUTES} (one week).` };
  return { ok: true, minutes };
}

const current = (m: number): string => (m === 0 ? 'Off' : plural(m, 'minute'));

function MinutesField({ settingKey, label, hint, value }: { settingKey: 'idleMinutes' | 'longRunMinutes'; label: string; hint: string; value: number }) {
  const { adopt } = useAppState();
  // What is typed, or null while the field just shows the saved value: a save keeps this form mounted,
  // so "Saved." and the focus stay.
  const [draft, setDraft] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);
  const shown = draft ?? String(value);

  const save = async (): Promise<void> => {
    setSaved(false);
    const parsed = parseMinutes(shown);
    if (!parsed.ok) {
      setError(parsed.message);
      return;
    }
    setError(null);
    setBusy(true);
    try {
      adopt(await api.setSetting(settingKey, parsed.minutes));
      setDraft(null);
      setSaved(true);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form
      className="reminder-field"
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      <Field label={label} hint={hint} error={error}>
        {({ id, describedBy }) => (
          <div className="inline-actions">
            <input id={id} className="input input-narrow" type="text" inputMode="numeric" value={shown} onChange={(e) => {
              setDraft(e.target.value);
              setSaved(false);
            }} aria-describedby={describedBy} aria-invalid={error ? true : undefined} />
            <Button type="submit" disabled={busy}>
              Save
            </Button>
            <span className="muted" data-testid={`current-${settingKey}`}>
              Now: {current(value)}
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

export function RemindersSection() {
  const { snapshot, adopt } = useAppState();
  const s = snapshot.reminderSettings;
  const [error, setError] = useState<string | null>(null);

  const setPastShift = async (v: boolean): Promise<void> => {
    setError(null);
    try {
      adopt(await api.setSetting('remindPastShift', v));
    } catch (e) {
      setError(errorMessage(e));
    }
  };

  return (
    <div className="settings-stack">
      <p>
        While a task runs, zWorkTracker watches for time away from the computer and for a timer that may have been left running. The app sends the system notification itself, and the same reminder shows at the top of this window with a Pause button.
      </p>
      <MinutesField
        settingKey="idleMinutes"
        label="Treat no activity as time away after (minutes)"
        hint="Default 10. 0 turns it off. When you come back, you decide what happens to that time. Unconfirmed: not counted until you confirm."
        value={s.idleMinutes}
      />
      <MinutesField
        settingKey="longRunMinutes"
        label="Remind me when a task has run for (minutes)"
        hint="Default 240, which is 4 hours. 0 turns it off."
        value={s.longRunMinutes}
      />
      <div>
        <Switch checked={s.remindPastShift} onChange={(v) => void setPastShift(v)} label="Remind me when a task runs past the end of my shift" hint="Uses the shifts set up under Shifts." />
        {error && (
          <p className="field-error" role="alert">
            {error}
          </p>
        )}
      </div>
    </div>
  );
}
