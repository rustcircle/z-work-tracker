// Device reference prefix, with a clash warning. References are `<prefix>-<number>`, unique per device.
import { useState } from 'react';

import { useApp } from '../../app/store';
import { Button, Field } from '../../components/ui';
import { api } from '../../lib/api';
import { messageOf } from '../billing/parts';
import '../billing/billing.css';

/** The reference the next summary would get under `prefix`: numbers count up per prefix and a voided one still counts. */
export function nextReference(prefix: string, taken: readonly { prefix: string; number: number }[]): string {
  const last = taken.filter((b) => b.prefix === prefix).reduce((m, b) => Math.max(m, b.number), 0);
  return `${prefix}-${String(last + 1).padStart(3, '0')}`;
}

export function BillingPrefixSection() {
  const { snapshot, adopt } = useApp();
  const { prefix, clashes, summaries } = snapshot.billing;
  const [draft, setDraft] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState<string | null>(null);

  const value = draft ?? prefix;
  const normalized = value.trim().toUpperCase();
  const changed = normalized !== prefix;
  // The backend decides what is allowed; this only keeps the example reference from showing nonsense.
  const shown = changed && /^[A-Z0-9]{1,4}$/.test(normalized) ? normalized : prefix;

  async function save(): Promise<void> {
    setBusy(true);
    setError(null);
    setSaved(null);
    try {
      const next = await api.setDevicePrefix(value);
      adopt(next);
      setDraft(null);
      setSaved(next.billing.prefix);
    } catch (e) {
      setError(messageOf(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="settings-stack">
      <p>
        Every billing summary gets a reference of the form <strong>&lt;prefix&gt;-&lt;number&gt;</strong>, such as <code>{prefix}-001</code>. The prefix is this computer&apos;s own, so references stay unique per device, and a number is never reused, even after its summary is voided.
      </p>
      <form
        className="bl-prefix-form"
        onSubmit={(e) => {
          e.preventDefault();
          if (changed && !busy) void save();
        }}
      >
        <Field label="Prefix of this device" hint="1 to 4 letters or digits. Shown in capitals." error={error}>
          {({ id, describedBy }) => (
            <input
              id={id}
              className="input bl-prefix-input"
              type="text"
              value={value}
              maxLength={12}
              autoComplete="off"
              spellCheck={false}
              aria-invalid={error ? true : undefined}
              aria-describedby={describedBy}
              onChange={(e) => {
                setDraft(e.target.value.toUpperCase());
                setError(null);
                setSaved(null);
              }}
            />
          )}
        </Field>
        <Button type="submit" variant="primary" disabled={!changed || busy}>
          {busy ? 'Saving…' : 'Save prefix'}
        </Button>
      </form>
      <p className="field-hint" data-testid="next-reference">
        The next summary on this device will be <strong>{nextReference(shown, summaries)}</strong>.
      </p>
      <p className="field-hint" role="status" aria-live="polite">
        {saved ? `Prefix saved: ${saved}.` : ''}
      </p>
      {clashes.length > 0 && (
        <div className="bl-clash" role="alert" data-testid="prefix-clash">
          <strong>Warning: another device uses the same prefix.</strong> References could repeat. Choose a different prefix on this device, or on the other one.
          <ul aria-label="Devices with the same prefix">
            {clashes.map((name) => (
              <li key={name}>{name}</li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
