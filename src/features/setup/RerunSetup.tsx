import { useState } from 'react';

import { Button, ConfirmDialog } from '../../components/ui';
import { useSetup } from './setupContext';

/** Settings entry for the wizard. It changes settings only, and never touches data. */
export function RerunSetup() {
  const { startRerun } = useSetup();
  const [asking, setAsking] = useState(false);
  return (
    <div className="settings-stack">
      <p>Go through the first-run settings again: theme, time zones, rounding, sync and start with Windows. Your projects, shifts, tasks and logged time are not part of it and are not touched.</p>
      <div>
        <Button onClick={() => setAsking(true)}>Run setup again</Button>
      </div>
      <ConfirmDialog
        open={asking}
        title="Run setup again?"
        confirmLabel="Run setup"
        onCancel={() => setAsking(false)}
        onConfirm={() => {
          setAsking(false);
          startRerun();
        }}
      >
        <p>Each step shows your current choice. Theme, time zones and Start with Windows change as soon as you pick them: Next keeps the choice, and Skip, Back and Exit put back what it was when you opened the step. If you quit the app in the middle of a step, what you already picked there stays, and setup doesn't come back on its own. You can change it in Settings. Your data stays as it is.</p>
      </ConfirmDialog>
    </div>
  );
}
