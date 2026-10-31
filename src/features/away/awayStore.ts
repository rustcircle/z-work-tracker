// A tiny signal that asks the time-away dialog to open, so the banner, the timeline and the dialog need
// no shared parent. It counts requests; the dialog opens itself when the count moves past what it saw.
import { useSyncExternalStore } from 'react';

let requests = 0;
const listeners = new Set<() => void>();

/** Ask for the time-away dialog to open. */
export function openAway(): void {
  requests += 1;
  for (const l of listeners) l();
}

const subscribe = (l: () => void): (() => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};

export const getAwayRequests = (): number => requests;

export function useAwayRequests(): number {
  return useSyncExternalStore(subscribe, getAwayRequests, getAwayRequests);
}
