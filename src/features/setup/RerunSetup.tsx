import { useState } from 'react';

import { Button, ConfirmDialog } from '../../components/ui';
import { useSetup } from './setupContext';

/** Settings entry for the wizard. It changes settings only when a step is confirmed and never touches data. */
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
        <p>Each step shows your current choice. A setting is kept only when you press Next on its step; Skip, Back and Exit put back what it was when you opened the step. Your data stays as it is.</p>
      </ConfirmDialog>
    </div>
  );
}
