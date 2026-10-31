import { AppProvider, useApp } from './app/store';
import { Banners } from './components/Banners';
import { ErrorBoundary } from './components/ErrorBoundary';
import { HideNoticeDialog } from './components/HideNoticeDialog';
import { Shell } from './components/Shell';
import { ToastProvider } from './components/Toasts';
import { SyncPrompt } from './features/settings/SyncPrompt';

import './styles/ui.css';
import './styles/shell.css';
import './styles/tasks.css';
import './styles/timeline.css';
import './styles/pages.css';
import './styles/tiptap.css';

function Root() {
  const { snapshot } = useApp();
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
        <Root />
      </ToastProvider>
    </AppProvider>
    </ErrorBoundary>
  );
}
