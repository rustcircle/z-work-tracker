import { useAppState } from '../app/store';
import { api } from '../lib/api';
import { AwayBanner, AwayDialog } from '../features/away/AwayDialog';
import { ReminderBanner } from '../features/away/ReminderBanner';
import { ColorNoticeBar } from './colorNotice';
import { IconClose, IconInfo, IconWarn } from './icons';
import { useCommands } from './useCommands';

/** Errors, always-visible warnings, and dismissible notices from the backend. */
export function Banners() {
  const { snapshot, error, clearError } = useAppState();
  const { act } = useCommands();
  return (
    <div className="banners">
      {error && (
        <div className="banner banner-error" role="alert">
          <IconWarn />
          <span>{error}</span>
          <button type="button" className="icon-btn" aria-label="Dismiss error" onClick={clearError}>
            <IconClose />
          </button>
        </div>
      )}
      {snapshot.warnings.map((w) => (
        <div key={w} className="banner banner-warning" role="status" data-testid="warning">
          <IconWarn />
          <span>{w}</span>
        </div>
      ))}
      <ColorNoticeBar />
      <ReminderBanner />
      <AwayBanner />
      <AwayDialog />
      {snapshot.notices.map((n) => (
        <div key={n.id} className={`banner ${n.level === 'warning' ? 'banner-warning' : 'banner-info'}`} role="status" data-testid="notice">
          {n.level === 'warning' ? <IconWarn /> : <IconInfo />}
          <span>{n.message}</span>
          <button type="button" className="icon-btn" aria-label={`Dismiss notice: ${n.message}`} onClick={() => void act(() => api.dismissNotice(n.id))}>
            <IconClose />
          </button>
        </div>
      ))}
    </div>
  );
}
