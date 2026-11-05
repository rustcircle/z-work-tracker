// Which days the Timeline draws side by side: as many as fit the width, the oldest on the left and the newest on
// the right, moved a page of days at a time. Pure, so every edge of the paging is easy to test.

/** The narrowest a day column reads well at: its axis, and a table of times, tasks and projects. */
export const MIN_DAY_WIDTH = 420;
/** The gap between two day columns, in pixels: the same number as `.days` in timeline.css. */
export const DAY_GAP = 16;
/** Days drawn where there is no layout to measure, as in a test (jsdom): a fortnight, which is what the Timeline always drew. */
export const UNMEASURED_FIT = 14;

/** A page scrollbar's width, with a little to spare. */
const SCROLLBAR_ROOM = 24;

/** How many day columns fit side by side in `width` pixels: at least one. */
export function daysThatFit(width: number): number {
  return Math.max(1, Math.floor((width + DAY_GAP) / (MIN_DAY_WIDTH + DAY_GAP)));
}

/**
 * The count after a measure. It falls as soon as the width no longer holds it, but grows only when the new count
 * holds with a scrollbar's width to spare. The page's height decides whether it has a scrollbar and the days decide
 * the page's height, so near a boundary a plain `daysThatFit` would flip between two counts for as long as the window sits there.
 */
export function settleFit(was: number, width: number): number {
  return Math.min(daysThatFit(width), Math.max(daysThatFit(width - SCROLLBAR_ROOM), was));
}

export interface Strip {
  /** The days to draw, oldest first, so the newest is at the right. */
  shown: string[];
  canEarlier: boolean;
  canLater: boolean;
  /** The day to hold at the right edge after a step back, and after a step forward. Null is the newest day: the strip follows it. */
  earlier: string | null;
  later: string | null;
}

/**
 * `days` is newest first, as the model lists them. `last` is the day held at the right edge, or null to follow the
 * newest, so a day logged later never moves what you are looking at. A step moves a page: as many days as are
 * shown. The strip stays full while there are enough days, so a step back stops at the oldest day.
 */
export function stripOf(days: readonly string[], last: string | null, fit: number): Strip {
  const size = Math.max(1, Math.floor(fit));
  const room = Math.max(0, days.length - size);
  // Where the right edge sits in the newest-first list: the days newer than `last`, but never so far back that the strip is short.
  const start = last === null ? 0 : Math.min(days.filter((d) => d > last).length, room);
  const anchor = (i: number): string | null => (i === 0 ? null : (days[i] ?? null));
  return {
    shown: days.slice(start, start + size).reverse(),
    canEarlier: start < room,
    canLater: start > 0,
    earlier: anchor(Math.min(start + size, room)),
    later: anchor(Math.max(0, start - size)),
  };
}
