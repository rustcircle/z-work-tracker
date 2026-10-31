import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import App from './App';
import './styles/base.css';

async function boot(): Promise<void> {
  // The e2e build runs against a mock of the backend. This branch is removed from production builds.
  if (import.meta.env.MODE === 'e2e') {
    const { installE2eBackend } = await import('./mocks/e2eEntry');
    installE2eBackend();
  }
  const root = document.getElementById('root');
  if (root) {
    createRoot(root).render(
      <StrictMode>
        <App />
      </StrictMode>,
    );
  }
}

void boot();
