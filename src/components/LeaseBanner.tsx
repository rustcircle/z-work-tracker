// The line under the header that says who may change the data. Only one computer at a time may, on a best effort basis: cloud folders
// update late and can't lock anything, so what it says about the other computer is what this one has heard, and the words say that.
// While another computer holds the lease this one is read-only and the line names it, says when it was last heard from, and offers
// to look again or to take over (`TakeOverDialog`). With no folder, or when this computer holds the lease or nobody does, there is no line.
//
// The setup wizard doesn't render the Shell, so it renders this itself: the dialog is part of it.
import { useState, type ReactNode } from 'react';

import { useApp, useAppState } from '../app/store';
import { api } from '../lib/api';
import type { LeaseView } from '../lib/types';
import { IconWarn } from './icons';
import { OFFER_TAKE_OVER_TO_A_LIVE_HOLDER, TakeOverDialog, ageOf, ageText, holderName, takeOverOffered } from './TakeOverDialog';
import { Button } from './ui';

/** Which line the lease calls for, or null for none. */
export type BannerKind = 'live' | 'stale' | 'unreachableReadOnly' | 'unreachableWritable';

export function bannerKind(lease: LeaseView): BannerKind | null {
  switch (lease.state) {
    case 'heldByOtherLive':
      return 'live';
    case 'heldByOtherStale':
      return 'stale';
    case 'unknown':
      return lease.readOnly ? 'unreachableReadOnly' : 'unreachableWritable';
    case 'off':
    case 'checking':
    case 'free':
    case 'heldByMe':
      return null;
    default: {
      const unreachable: never = lease.state;
      return unreachable;
    }
  }
}

export interface LeaseBannerProps {
  /** D2: see `OFFER_TAKE_OVER_TO_A_LIVE_HOLDER`. Only a test passes it. */
  offerToLive?: boolean;
}

export function LeaseBanner({ offerToLive = OFFER_TAKE_OVER_TO_A_LIVE_HOLDER }: LeaseBannerProps) {
  const { snapshot, act } = useAppState();
  const lease = snapshot.lease;
  const kind = bannerKind(lease);
  const [taking, setTaking] = useState(false);
  const [checking, setChecking] = useState(false);

  // Asking again wakes the lease check along with a sync: what the folders say now arrives as a new snapshot.
  const check = (): void => {
    if (checking) return;
    setChecking(true);
    void act(() => api.syncNow()).finally(() => setChecking(false));
  };

  return (
    <>
      {kind && <Line lease={lease} kind={kind} offered={takeOverOffered(kind === 'live', offerToLive)} checking={checking} onCheck={check} onTakeOver={() => setTaking(true)} />}
      <TakeOverDialog open={taking} onClose={() => setTaking(false)} offerToLive={offerToLive} />
    </>
  );
}

/** The age is the one part that moves by itself. A screen reader is not told each minute that it did. */
function Age({ secs }: { secs: number }) {
  return <span aria-live="off">{ageText(secs)}</span>;
}

function Line({ lease, kind, offered, checking, onCheck, onTakeOver }: { lease: LeaseView; kind: BannerKind; offered: boolean; checking: boolean; onCheck: () => void; onTakeOver: () => void }) {
  const { nowSec } = useApp();
  const holder = lease.holder;
  const name = holderName(holder);
  const age = holder ? ageOf(holder, nowSec) : null;
  const skew = holder?.clockSuspect ? " Its clock seems to differ from this computer's." : '';

  let text: ReactNode;
  switch (kind) {
    case 'live':
      text = (
        <>
          <strong>Read-only.</strong> {name} is using zWorkTracker
          {age !== null && (
            <>
              {' '}
              (last seen <Age secs={age} /> ago)
            </>
          )}
          . You can look at everything here. Changes are off so the two computers don&apos;t overlap.{skew}
        </>
      );
      break;
    case 'stale':
      text = (
        <>
          <strong>Read-only.</strong> {name} looks inactive: {age !== null ? <>nothing from it for <Age secs={age} /></> : 'nothing has been heard from it'}. It may be off, or its cloud app may simply not have synced yet.{skew}
        </>
      );
      break;
    case 'unreachableReadOnly':
      text = (
        <>
          <strong>Read-only.</strong> The sync folder can&apos;t be reached, and {name} {age !== null ? <>was last using zWorkTracker <Age secs={age} /> ago</> : 'was the last computer known to use zWorkTracker'}.
        </>
      );
      break;
    case 'unreachableWritable':
      text = <>The sync folder can&apos;t be reached, so this computer can&apos;t check whether another one is in use. You can keep working. Everything merges when the folder is back.</>;
      break;
    default: {
      const unreachable: never = kind;
      return unreachable;
    }
  }

  return (
    <div className="banner banner-warning" role="status" data-testid="lease-banner" data-state={lease.state}>
      <IconWarn />
      <span data-testid="lease-text">
        {text}
        {lease.note && (
          <>
            {' '}
            <span data-testid="lease-note" style={{ display: 'block' }}>
              {lease.note}
            </span>
          </>
        )}
      </span>
      {kind === 'live' && !offered && (
        <span data-testid="lease-how" style={{ display: 'block' }}>
          To work here, quit it or press Release now there, or ask it to pause its task with Pause it from here. Take over appears once nothing has come from it for 15 minutes.
        </span>
      )}
      {kind !== 'unreachableWritable' && (
        <div className="banner-actions">
          <Button small disabled={checking} onClick={onCheck}>
            {checking ? 'Checking…' : 'Check again'}
          </Button>
          {kind === 'unreachableReadOnly' ? (
            <Button small aria-haspopup="dialog" onClick={onTakeOver}>
              Work here anyway…
            </Button>
          ) : (
            offered && (
              <Button small aria-haspopup="dialog" onClick={onTakeOver}>
                Take over…
              </Button>
            )
          )}
        </div>
      )}
    </div>
  );
}
