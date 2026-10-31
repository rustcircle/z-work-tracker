import { useState } from 'react';

import { useApp } from '../../app/store';
import { api } from '../../lib/api';
import { zoneLabel } from '../../lib/tz';
import { Button, Field } from '../../components/ui';
import { useCommands } from '../../components/useCommands';
import { ZonePickerDialog } from '../zones';

export function ZonesSection() {
  const { snapshot, zones, nowSec } = useApp();
  const { act } = useCommands();
  const [pick, setPick] = useState<'my' | 'client' | null>(null);
  const s = snapshot.settings;

  const set = (key: string, value: unknown) => void act(() => api.setSetting(key, value));

  return (
    <div className="settings-stack">
      <div className="kv">
        <div>
          <p className="kv-label">My zone</p>
          <p data-testid="my-zone">{zoneLabel(zones.my, nowSec)}</p>
          <p className="field-hint">{s.myZone ? 'Chosen by you.' : `Taken from this computer (${snapshot.systemZone}).`}</p>
        </div>
        <div className="inline-actions">
          <Button small onClick={() => setPick('my')}>
            Change my zone
          </Button>
          {s.myZone && (
            <Button small variant="ghost" onClick={() => set('myZone', null)}>
              Use this computer's zone
            </Button>
          )}
        </div>
      </div>
      <div className="kv">
        <div>
          <p className="kv-label">Client zone</p>
          <p data-testid="client-zone">{zones.client ? zoneLabel(zones.client, nowSec) : 'Not set'}</p>
          <p className="field-hint">Used by "Show both", the client axis and exports. Individual projects can use their own.</p>
        </div>
        <div className="inline-actions">
          <Button small onClick={() => setPick('client')}>
            {zones.client ? 'Change client zone' : 'Set client zone'}
          </Button>
          {zones.client && (
            <Button small variant="ghost" onClick={() => set('clientZone', null)}>
              Clear
            </Button>
          )}
        </div>
      </div>
      <div className="row-fields">
        <Field label="Client working hours start">
          {({ id }) => <input id={id} className="input" type="time" value={s.clientWorkStart ?? '09:00'} onChange={(e) => e.target.value && set('clientWorkStart', e.target.value)} />}
        </Field>
        <Field label="Client working hours end">
          {({ id }) => <input id={id} className="input" type="time" value={s.clientWorkEnd ?? '17:00'} onChange={(e) => e.target.value && set('clientWorkEnd', e.target.value)} />}
        </Field>
      </div>
      <p className="field-hint">The client's day, in their zone. Show both shades these hours and counts how much of your logged time falls inside them.</p>
      <ZonePickerDialog
        open={pick !== null}
        title={pick === 'client' ? 'Client zone' : 'My zone'}
        value={pick === 'client' ? zones.client : zones.my}
        onPick={(z) => {
          const which = pick;
          setPick(null);
          if (which) set(which === 'client' ? 'clientZone' : 'myZone', z);
        }}
        onClose={() => setPick(null)}
      />
    </div>
  );
}
