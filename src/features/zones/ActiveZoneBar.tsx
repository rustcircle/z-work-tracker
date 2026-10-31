import { useState } from 'react';

import { useApp } from '../../app/store';
import { api } from '../../lib/api';
import { cityOf, zoneLabel } from '../../lib/tz';
import { ZonePickerDialog } from './ZonePickerDialog';

import './zones.css';

type Choice = 'my' | 'client' | 'utc' | 'other';

/**
 * Chooses the zone that all grouping and totals follow, and always shows which one is in use. The
 * choice is stored as the `activeZone` setting (null means "follow My zone") and `showBoth`.
 */
export function ActiveZoneBar() {
  const { zones, nowSec, act } = useApp();
  const [picking, setPicking] = useState(false);
  const { my, client, active } = zones;

  const current: Choice = active === my ? 'my' : active === client ? 'client' : active === 'UTC' ? 'utc' : 'other';
  const setActive = (zone: string | null) => void act(() => api.setSetting('activeZone', zone));

  return (
    <div className="zn-bar" role="group" aria-label="Time zone for days and totals" data-testid="active-zone-bar">
      <div className="zn-seg">
        <button type="button" className="zn-seg-btn" aria-pressed={current === 'my'} onClick={() => setActive(null)}>
          My time
        </button>
        <button
          type="button"
          className="zn-seg-btn"
          aria-pressed={current === 'client'}
          disabled={!client}
          title={client ? undefined : 'Set a client zone in Settings to use this'}
          onClick={() => client && setActive(client)}
        >
          Client time
        </button>
        <button type="button" className="zn-seg-btn" aria-pressed={current === 'utc'} onClick={() => setActive('UTC')}>
          UTC
        </button>
        <button
          type="button"
          className="zn-seg-btn"
          aria-pressed={current === 'other'}
          aria-haspopup="dialog"
          onClick={() => setPicking(true)}
        >
          {current === 'other' ? `Other: ${cityOf(active)}` : 'Other…'}
        </button>
      </div>
      <span className="zn-bar-label" data-testid="active-zone-label" aria-live="polite">
        <span className="muted">Showing</span> {zoneLabel(active, nowSec)}
      </span>
      {client && (
        <button
          type="button"
          role="switch"
          className="zn-switch"
          aria-checked={zones.showBoth}
          onClick={() => void act(() => api.setSetting('showBoth', !zones.showBoth))}
        >
          <span className="zn-switch-track" aria-hidden="true">
            <span className="zn-switch-thumb" />
          </span>
          Show both
        </button>
      )}
      <ZonePickerDialog
        open={picking}
        title="Show times in another zone"
        value={active}
        onPick={(zone) => setActive(zone)}
        onClose={() => setPicking(false)}
      />
    </div>
  );
}
