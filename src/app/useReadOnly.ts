// Whether this computer may change shared data right now. While another computer holds the lease the backend refuses
// every such change (code `read_only`), and that refusal is the guarantee. This only lets the page show it early:
// controls disabled, an editor that can't be typed in, instead of an error after the click.
import { useMemo } from 'react';

import type { LeaseView } from '../lib/types';
import { useAppState } from './store';

export interface ReadOnly {
  readOnly: boolean;
  /** Why, in the words of the backend's refusal, for a tooltip or a line beside a disabled control. Null while changes are allowed. */
  why: string | null;
}

const WRITABLE: ReadOnly = { readOnly: false, why: null };

/** The backend's refusal (`CoreError::ReadOnly`) for a change made while another computer holds the lease. */
export function readOnlyMessage(holderName: string): string {
  return `${holderName} is using zWorkTracker, so this computer is read-only. Take over from the banner to work here.`;
}

function answer(readOnly: boolean, holderName: string | null): ReadOnly {
  return readOnly ? { readOnly: true, why: readOnlyMessage(holderName ?? 'Another computer') } : WRITABLE;
}

/** The same answer for code outside React, from the lease of any snapshot. */
export function readOnlyOf(lease: LeaseView): ReadOnly {
  return answer(lease.readOnly, lease.holder?.deviceName ?? null);
}

/**
 * The answer changes only when the lease does, not with every snapshot, and until then it is the same object, so it is safe
 * in a dependency list. Prefer disabling a control to hiding it, with `why` as its explanation.
 */
export function useReadOnly(): ReadOnly {
  const { lease } = useAppState().snapshot;
  const holderName = lease.holder?.deviceName ?? null;
  return useMemo(() => answer(lease.readOnly, holderName), [lease.readOnly, holderName]);
}
