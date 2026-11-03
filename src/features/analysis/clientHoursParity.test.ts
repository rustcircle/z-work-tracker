// UI review R6: the Timeline and Analysis count the client's working hours by one rule. Every day of the
// week counts, weekends included, because the user may work 24/7, and hours that end at or before they
// start (22:00 to 06:00) run overnight into the next day. Each case holds both call sites, and the figure
// on the Zones card, to the same number of seconds.
import { describe, expect, it } from 'vitest';

import { dayBounds, dayOf, parseIso, type DayBounds } from '../../lib/tz';
import { overlapSecs, workWindows } from '../timeline/model';
import { clientWorkWindows } from './engine';
import { analyze } from './metrics';
import { mkSnapshot, nowOf, params } from './testkit';

const VIEW = 'UTC';
const NOW = '2026-03-20T12:00:00Z';

interface Case {
  name: string;
  client: string;
  hours: [string, string];
  /** Logged time, as ISO instants. */
  piece: [string, string];
  /** Seconds of it that fall inside the client's hours. */
  secs: number;
}

const CASES: Case[] = [
  { name: 'a weekday inside the hours', client: 'America/New_York', hours: ['09:00', '17:00'], piece: ['2026-03-10T14:00:00Z', '2026-03-10T16:00:00Z'], secs: 7200 },
  { name: 'a Saturday inside the hours', client: 'America/New_York', hours: ['09:00', '17:00'], piece: ['2026-03-14T15:00:00Z', '2026-03-14T17:00:00Z'], secs: 7200 },
  { name: 'a Sunday inside the hours', client: 'America/New_York', hours: ['09:00', '17:00'], piece: ['2026-03-15T15:00:00Z', '2026-03-15T17:00:00Z'], secs: 7200 },
  { name: 'a Saturday that starts before the hours open', client: 'America/New_York', hours: ['09:00', '17:00'], piece: ['2026-03-14T12:00:00Z', '2026-03-14T14:00:00Z'], secs: 3600 },
  { name: 'hours 22:00-06:00, time before they end', client: 'UTC', hours: ['22:00', '06:00'], piece: ['2026-03-10T04:00:00Z', '2026-03-10T06:00:00Z'], secs: 7200 },
  { name: 'hours 22:00-06:00, time after they begin', client: 'UTC', hours: ['22:00', '06:00'], piece: ['2026-03-10T22:00:00Z', '2026-03-11T00:00:00Z'], secs: 7200 },
  { name: 'hours 22:00-06:00, time around the whole night', client: 'UTC', hours: ['22:00', '06:00'], piece: ['2026-03-10T21:00:00Z', '2026-03-11T07:00:00Z'], secs: 28800 },
  { name: 'hours 22:00-06:00, a night over a weekend', client: 'UTC', hours: ['22:00', '06:00'], piece: ['2026-03-14T23:00:00Z', '2026-03-15T05:00:00Z'], secs: 21600 },
  { name: 'hours 22:00-06:00 on the night the clocks go forward', client: 'America/New_York', hours: ['22:00', '06:00'], piece: ['2026-03-08T00:00:00Z', '2026-03-08T12:00:00Z'], secs: 25200 },
  { name: 'hours 00:00-00:00 are round the clock', client: 'UTC', hours: ['00:00', '00:00'], piece: ['2026-03-14T20:00:00Z', '2026-03-15T02:00:00Z'], secs: 21600 },
];

const firstDay = (c: Case): string => dayOf(parseIso(c.piece[0]), VIEW);
const lastDay = (c: Case): string => dayOf(parseIso(c.piece[1]) - 1, VIEW);

const snapshotOf = (c: Case) =>
  mkSnapshot({
    now: NOW,
    projects: [{ id: 'p' }],
    tasks: [{ id: 't', projectId: 'p' }],
    segs: [['t', c.piece[0], c.piece[1]]],
    settings: { myZone: VIEW, clientZone: c.client, clientWorkStart: c.hours[0], clientWorkEnd: c.hours[1] },
  });

/** The Timeline's way (DayCard): each day of the piece against that day's windows. */
function timelineSecs(c: Case): number {
  const piece = { start: parseIso(c.piece[0]), end: parseIso(c.piece[1]) };
  let total = 0;
  for (let d = firstDay(c); d <= lastDay(c); d = dayOf(dayBounds(d, VIEW).end, VIEW)) {
    const day: DayBounds = dayBounds(d, VIEW);
    const part = { start: Math.max(piece.start, day.start), end: Math.min(piece.end, day.end) };
    total += overlapSecs([part], workWindows(day.start, day.end, c.client, c.hours[0], c.hours[1]));
  }
  return total;
}

/** Analysis's way: the windows of the whole period, as the engine builds them. */
function analysisSecs(c: Case): number {
  const from = dayBounds(firstDay(c), VIEW).start;
  const to = dayBounds(lastDay(c), VIEW).end;
  const windows = clientWorkWindows(snapshotOf(c), c.client, from, to).map(([start, end]) => ({ start, end }));
  return overlapSecs([{ start: parseIso(c.piece[0]), end: parseIso(c.piece[1]) }], windows);
}

/** The figure on the Zones card, end to end. */
function cardSecs(c: Case): number {
  const range = { kind: 'custom', anchor: firstDay(c), from: firstDay(c), to: lastDay(c) } as const;
  return analyze(snapshotOf(c), params(VIEW, range), nowOf(NOW), 'exact').zonesView.overlapSecs;
}

describe('R6: client working hours, Timeline and Analysis', () => {
  it.each(CASES)('$name', (c) => {
    expect({ timeline: timelineSecs(c), analysis: analysisSecs(c), card: cardSecs(c) }).toEqual({ timeline: c.secs, analysis: c.secs, card: c.secs });
  });
});
