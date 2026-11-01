import { useState } from 'react';

import { AppProvider, useAppState } from './app/store';
import { Banners } from './components/Banners';
import { ColorNoticeProvider } from './components/colorNotice';
import { ErrorBoundary } from './components/ErrorBoundary';
import { HideNoticeDialog } from './components/HideNoticeDialog';
import { Shell } from './components/Shell';
import { ToastProvider } from './components/Toasts';
import { SyncPrompt } from './features/settings/SyncPrompt';
import { SetupProvider, useSetup } from './features/setup/setupContext';
import { SetupWizard } from './features/setup/SetupWizard';

import './styles/ui.css';
import './styles/shell.css';
import './styles/tasks.css';
import './styles/timeline.css';
import './styles/pages.css';
import './styles/tiptap.css';

function Root() {
  const { snapshot } = useAppState();
  const { rerun, endRerun } = useSetup();
  // Connecting a sync folder makes the backend count the one-time prompt as answered, which turns `pending`
  // off in the middle of setup. The wizard therefore stays up on its own flag once it has started.
  const [began, setBegan] = useState(false);
  if (snapshot.setup.pending && !began) setBegan(true);
  const finished = () => {
    setBegan(false);
    endRerun();
  };
  if (began || rerun) {
    return (
      <>
        <SetupWizard onFinished={finished} rerun={rerun && !began} />
        <HideNoticeDialog />
      </>
    );
  }
  return (
    <>
      {snapshot.sync.promptPending ? (
        <>
          <Banners />
          <SyncPrompt />
        </>
      ) : (
        <Shell />
      )}
      <HideNoticeDialog />
    </>
  );
}

export default function App() {
  return (
    <ErrorBoundary>
    <AppProvider
      fallback={(error) => (
        <div className="loading" role={error ? 'alert' : 'status'}>
          {error ? `Could not load your data: ${error}` : 'Loading…'}
        </div>
      )}
    >
      <ToastProvider>
        <ColorNoticeProvider>
          <SetupProvider>
            <Root />
          </SetupProvider>
        </ColorNoticeProvider>
      </ToastProvider>
    </AppProvider>
    </ErrorBoundary>
  );
}
