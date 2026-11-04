// The forgotten-timer reminder, in the window. The backend sends the system notification itself.
import { useApp } from '../../app/store';
import { clock } from '../../components/format';
import { IconWarn } from '../../components/icons';
import { TimerButton } from '../../components/TimerButton';
import { Button } from '../../components/ui';
import { useCommands } from '../../components/useCommands';
import { api } from '../../lib/api';
import { parseIso } from '../../lib/tz';
import { longRunText } from './awayLogic';
import './away.css';

export function ReminderBanner() {
  const { snapshot, nowSec, zones } = useApp();
  const { act } = useCommands();
  const r = snapshot.reminder;
  if (!r) return null;
  const task = snapshot.tasks.find((t) => t.id === r.taskId);
  const name = task?.name ?? 'A task';
  const why =
    r.kind === 'longRun'
      ? `Running for ${longRunText(nowSec - parseIso(r.since))} since ${clock(parseIso(r.since), zones.active)}.`
      : `Past the end of your ${r.shift} shift (${clock(parseIso(r.ended), zones.active)}).`;
  return (
    <div className="banner banner-warning banner-reminder" role="status" data-testid="reminder-banner" data-kind={r.kind}>
      <IconWarn />
      <span>
        <strong>{name}</strong> is still running. {why} Did you forget to stop it?
      </span>
      <div className="banner-actions">
        <TimerButton small variant="primary" onClick={() => void act(() => api.pauseTask(r.taskId))}>
          Pause
        </TimerButton>
        <Button small onClick={() => void act(() => api.snoozeReminder(60))}>
          Keep running 1 h
        </Button>
      </div>
    </div>
  );
}
