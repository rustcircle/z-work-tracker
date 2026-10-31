import { Component, type ErrorInfo, type ReactNode } from 'react';

import { Button } from './ui';

/** A render error must never leave a blank window: show what happened and a way back. */
export class ErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  override state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    // Only the console: nothing leaves the machine.
    console.error('zWorkTracker could not draw the window', error, info.componentStack);
  }

  override render(): ReactNode {
    if (!this.state.failed) return this.props.children;
    return (
      <main className="crash" role="alert" aria-labelledby="crash-title">
        <div className="crash-card">
          <h1 id="crash-title">Something went wrong</h1>
          <p>This window could not be drawn. Your data is safe: it is saved by the app in the background, not by this window, so nothing you logged is lost.</p>
          <p className="muted">Reloading the window draws it again from the saved data.</p>
          <Button variant="primary" onClick={() => window.location.reload()}>
            Reload
          </Button>
        </div>
      </main>
    );
  }
}
