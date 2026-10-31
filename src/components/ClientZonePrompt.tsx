import { useState } from 'react';

import { useApp } from '../app/store';
import { api } from '../lib/api';
import { ZonePickerDialog } from '../features/zones';
import { Button, Modal } from './ui';
import { useCommands } from './useCommands';

/** Asked once: there is no silent default client zone. */
export function ClientZonePrompt() {
  const { snapshot, zones } = useApp();
  const { act } = useCommands();
  const [step, setStep] = useState<'ask' | 'pick'>('ask');
  const pending = !snapshot.prefs.clientZonePromptDone && !snapshot.settings.clientZone;
  const done = () => void act(() => api.markClientZonePromptDone());
  return (
    <>
      <Modal
        open={pending && step === 'ask'}
        title="Do you work with a client in another time zone?"
        onClose={done}
        footer={
          <>
            <Button onClick={done}>Not now</Button>
            <Button variant="primary" onClick={() => setStep('pick')}>
              Choose client zone
            </Button>
          </>
        }
      >
        <p>Pick the zone your client works in and "Show both" can draw their day next to yours, mark when your hours overlap with theirs, and label exports in both zones.</p>
        <p className="muted">Nothing is assumed for you. You can set or change it later in Settings.</p>
      </Modal>
      <ZonePickerDialog
        open={pending && step === 'pick'}
        title="Client zone"
        value={zones.client}
        onPick={(z) => {
          setStep('ask');
          void act(() => api.setSetting('clientZone', z)).then((ok) => ok && act(() => api.markClientZonePromptDone()));
        }}
        onClose={() => setStep('ask')}
      />
    </>
  );
}
