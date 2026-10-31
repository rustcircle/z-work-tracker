import { useApp } from '../../app/store';
import { api } from '../../lib/api';
import { useCommands } from '../../components/useCommands';
import { SyncChooser } from './SyncChooser';

/** First launch: choose sync folders, or skip. Nothing is enabled silently. */
export function SyncPrompt() {
  const { snapshot } = useApp();
  const { act } = useCommands();
  return (
    <main className="firstrun" aria-labelledby="sync-title">
      <div className="firstrun-card">
        <h1 id="sync-title">Keep your devices in sync?</h1>
        <p className="lead">zWorkTracker can write its data into a OneDrive or Google Drive folder, so a second computer sees the same projects and time. It is optional, and you can change it later in Settings.</p>
        <SyncChooser detected={snapshot.sync.detected} existing={snapshot.sync.targets.map((t) => t.root)} onConnected={() => void act(() => api.markSyncPromptDone())} onSkip={() => void act(() => api.markSyncPromptDone())} />
      </div>
    </main>
  );
}
