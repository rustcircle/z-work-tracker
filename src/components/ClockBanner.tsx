// The line under the header that says this computer's clock is behind the newest change it has seen. Stamps follow a hybrid logical clock
// (design D1 §5): a change made here is dated after everything this computer has seen, up to a day past its own clock, so the latest save
// wins even when this clock is wrong. The price is dates that run ahead of the wall clock, so the person is told to check the date and time.
// From a gap of a day (`capped`) that no longer holds: a new change can't be dated after the newest one, so it may lose to it, and the line
// says so instead (design addendum A1.5). The backend decides whether to show it (`Snapshot.clockBehind`) and the page checks the same gap
// against its own clock between snapshots, so the line goes away by itself once the clock has caught up, and goes back to the plain words
// once the gap has fallen under a day, since a change made then can be dated after the newest one again.
//
// The time of the change is given in My zone, as `TakeOverDialog` gives another computer's last sign: it is the wall clock that this
// computer's own clock, which the person is told to check, is read against. The zone the Timeline is showing (`zones.active`, Client time
// perhaps) could put the change hours before the clock it is compared with.
//
// Always visible while it applies, with no dismiss button, as the backend's warnings are. It is a status, and the gap in it, the one part
// that moves by itself every minute, is kept out of what a screen reader is told, as the age in `LeaseBanner` is. The setup wizard and the
// one-time sync prompt don't render the Shell, so they render this themselves, where `LeaseBanner` would be.
import type { ReactElement } from 'react';

import { useApp } from '../app/store';
import { parseIso } from '../lib/tz';
import type { ClockBehindView } from '../lib/types';
import { IconWarn } from './icons';
import { whenText } from './TakeOverDialog';

/** The backend's `hlc::CLOCK_BEHIND_WARN_SECS`: the same 120 s as the lease's "its clock seems to differ". Below it nothing is said. */
export const CLOCK_BEHIND_WARN_SECS = 120;

/** The backend's `hlc::HLC_MAX_LEAD_SECS`: how far past its own clock a change made here may be dated, a day. From a gap this big it can't be dated after the newest change. */
export const CLOCK_BEHIND_CAPPED_SECS = 86_400;

/** "5 min", "1 h", "1 h 30 min", "1 day", "3 days": the backend's `span_text` words. */
export function behindSpan(secs: number): string {
  if (secs < 60) return 'less than a minute';
  const m = Math.floor(secs / 60);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  const r = m % 60;
  if (h < 24) return r ? `${h} h ${r} min` : `${h} h`;
  const d = Math.floor(h / 24);
  return d === 1 ? '1 day' : `${d} days`;
}

// What follows the first sentence: whether a new change can still be dated after the newest one, and what to check.
const AFTER_OTHER = 'New changes here are still dated after it, so they count as the newest. Check the date and time on both computers: one of them is wrong.';
const AFTER_HERE = "New changes are still dated after that one, so they count as the newest. Check this computer's date and time.";
const AFTER_CAPPED_OTHER = "Changes made here can't be dated after it until the clock is fixed, so they may lose to it. Check the date and time on both computers.";
// When the newest change was saved here, the other computer isn't in it: a person may have only this one.
const AFTER_CAPPED_HERE = "Changes made here can't be dated after it until the clock is fixed, so they may lose to it. Check this computer's date and time.";

/** `behind` is the gap on the page's clock. The capped words need the backend's `capped` and a gap that is still a day or more. */
function closing(view: ClockBehindView, behind: number): string {
  const here = view.causeDevice === null;
  if (view.capped && behind >= CLOCK_BEHIND_CAPPED_SECS) return here ? AFTER_CAPPED_HERE : AFTER_CAPPED_OTHER;
  return here ? AFTER_HERE : AFTER_OTHER;
}

/** The banner's words in three pieces, so that `gap`, which changes every minute, can be set apart from the rest. */
export interface ClockBehindParts {
  /** Up to the gap. */
  before: string;
  /** How far behind, in the backend's words. */
  gap: string;
  /** The rest of it. */
  after: string;
}

/**
 * The banner's words, or null when nothing is to be shown at `nowSec`. The gap is worked out from the time of the newest change and the
 * page's clock, not taken from `behindSecs`, so a line that has been up for an hour doesn't still say "1 h 30 min". The capped words need
 * `capped`, as the backend sent it, and a gap that is still a day or more on the page's clock: between two snapshots the gap only shrinks,
 * so the line stops saying that changes can't be dated after the newest one as soon as that is no longer true.
 */
export function clockBehindParts(view: ClockBehindView | null | undefined, nowSec: number, zone: string): ClockBehindParts | null {
  if (!view) return null;
  const newest = parseIso(view.newestAt);
  const behind = newest - nowSec;
  // Written so that a time that doesn't parse (NaN) says nothing, rather than "NaN days".
  if (!(behind >= CLOCK_BEHIND_WARN_SECS)) return null;
  const when = whenText(newest, nowSec, zone);
  const saved = view.causeDevice !== null ? `a change saved on ${view.causeDevice} at ${when}.` : `a change saved here at ${when}, so it seems to have been set back.`;
  return { before: "This computer's clock is ", gap: behindSpan(behind), after: ` behind ${saved} ${closing(view, behind)}` };
}

/** The banner's words as one text, or null when nothing is to be shown at `nowSec`. */
export function clockBehindText(view: ClockBehindView | null | undefined, nowSec: number, zone: string): string | null {
  const parts = clockBehindParts(view, nowSec, zone);
  return parts === null ? null : parts.before + parts.gap + parts.after;
}

/** Always visible while it applies; no dismiss button, as the backend's warnings. */
export function ClockBanner(): ReactElement | null {
  const { snapshot, nowSec, zones } = useApp();
  const parts = clockBehindParts(snapshot.clockBehind, nowSec, zones.my);
  if (parts === null) return null;
  return (
    <div className="banner banner-warning" role="status" data-testid="clock-behind">
      <IconWarn />
      <span className="banner-long">
        {parts.before}
        <span aria-live="off">{parts.gap}</span>
        {parts.after}
      </span>
    </div>
  );
}
