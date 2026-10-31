// Backend calls that return a TransitionResult: adopt its snapshot, report failures, and raise the
// auto-pause toast when starting one task paused another.
import { useCallback, useMemo } from 'react';

import { useApp } from '../app/store';
import type { TransitionResult } from '../lib/types';
import { useToast } from './Toasts';

export function useCommands() {
  const { adopt, showError, act } = useApp();
  const toast = useToast();

  const transition = useCallback(
    async (call: () => Promise<TransitionResult>, starting: string): Promise<boolean> => {
      try {
        const r = await call();
        adopt(r.snapshot);
        if (r.autoPausedTaskName) toast.push(`Paused "${r.autoPausedTaskName}" because you started "${starting}". Only one task is timed at a time.`);
        return true;
      } catch (e) {
        showError(e && typeof e === 'object' && 'message' in e ? String((e as { message: unknown }).message) : String(e));
        return false;
      }
    },
    [adopt, showError, toast],
  );

  return useMemo(() => ({ act, transition }), [act, transition]);
}
