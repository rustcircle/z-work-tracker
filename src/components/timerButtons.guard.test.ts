// Every place that sends a timer command draws its button with TimerButton, which refuses Space (see TimerButton.tsx). This reads the
// sources, so a new caller of one of these commands fails here until its button is a TimerButton and it is added to the list.
import { describe, expect, it } from 'vitest';

const sources = import.meta.glob<string>(['/src/**/*.tsx', '!/src/**/*.test.tsx', '!/src/mocks/**'], { query: '?raw', import: 'default', eager: true });

/** The backend commands that start, pause, resume, stop or continue a timer, or ask another computer to, or end its time. */
const TIMER_COMMAND = /\bapi\.(startTask|resumeTask|pauseTask|stopTask|requestRemotePause|settleLostSegment)\(/;

/** The files that send them today. */
const CALLERS = [
  '/src/features/away/ReminderBanner.tsx',
  '/src/features/tasks/TaskCard.tsx',
  '/src/features/tasks/TaskCardExtras.tsx',
  '/src/features/tasks/TaskForm.tsx',
  '/src/features/tasks/details/CorrectionsList.tsx',
];

describe('the places that send a timer command', () => {
  it('are the ones this guard knows of, and each draws its buttons with TimerButton so that Space presses none of them', () => {
    const callers = Object.entries(sources).filter(([, text]) => TIMER_COMMAND.test(text));
    expect(callers.map(([file]) => file).sort()).toEqual(CALLERS);
    // A file that draws <TimerButton> has imported it, or it would not compile.
    expect(callers.filter(([, text]) => !/<TimerButton\b/.test(text)).map(([file]) => file)).toEqual([]);
  });
});
