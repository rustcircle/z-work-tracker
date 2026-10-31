import { useApp } from '../app/store';
import { api } from '../lib/api';
import { Button, Modal } from './ui';
import { errorMessage } from '../lib/errorMessage';

/** Shown the first time the window is hidden: the app keeps running in the system tray. */
export function HideNoticeDialog() {
  const { hideNotice, clearHideNotice, showError } = useApp();
  const done = (): void => {
    clearHideNotice();
    api.ackHideNotice().catch((e: unknown) => showError(errorMessage(e)));
  };
  return (
    <Modal open={hideNotice !== null} title="zWorkTracker is still running" onClose={done} footer={<Button variant="primary" onClick={done}>OK</Button>}>
      <p>
        Closing the window hides it. The app stays in the system tray, and your time keeps being saved.{' '}
        {hideNotice?.running ? (
          <strong data-testid="hide-running">“{hideNotice.taskName ?? 'A task'}” is still being timed.</strong>
        ) : (
          <span data-testid="hide-running">No task is being timed right now.</span>
        )}
      </p>
      <p className="muted">Windows may tuck the tray icon into the overflow area. Click the small arrow near the clock to find it. To quit completely, use the tray icon's menu.</p>
    </Modal>
  );
}
