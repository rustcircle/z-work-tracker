import { describe, expect, it } from 'vitest';

import { parseIso } from '../../lib/tz';
import { clockChangeLines, dateText, gapNotice } from './notices';

// Demo "now": 12 March 2026. US clocks went forward on 8 Mar, EU clocks follow on 29 Mar.
const NOW = parseIso('2026-03-12T15:20:00Z');

describe('gap notices', () => {
  it('names each week-range in which Lisbon and New York are 4h or 5h apart', () => {
    const g = gapNotice('Europe/Lisbon', 'America/New_York', NOW);
    expect(g?.now).toBe('New York is 4h behind Lisbon');
    // 29 Mar: Lisbon to UTC+1 (5h). 25 Oct: Lisbon back to UTC+0 (4h). 1 Nov: New York back to UTC-5 (5h).
    // New York goes forward again on 14 Mar 2027, which is past the 12-month window.
    expect(g?.changes).toEqual([
      'New York is 5h behind Lisbon from 29 Mar',
      'New York is 4h behind Lisbon from 25 Oct',
      'New York is 5h behind Lisbon from 1 Nov',
    ]);
  });

  it('raises no change when both places change clocks on the same dates', () => {
    expect(gapNotice('Europe/Paris', 'Europe/Berlin', NOW)).toEqual({ a: 'Europe/Paris', b: 'Europe/Berlin', now: 'Berlin is at the same time as Paris', changes: [] });
  });

  it('raises no change for zones without daylight saving, and for a zone against itself', () => {
    expect(gapNotice('America/Phoenix', 'Pacific/Honolulu', NOW)).toEqual({
      a: 'America/Phoenix',
      b: 'Pacific/Honolulu',
      now: 'Honolulu is 3h behind Phoenix',
      changes: [],
    });
    expect(gapNotice('Asia/Kolkata', 'Asia/Kathmandu', NOW)?.changes).toEqual([]);
    expect(gapNotice('Asia/Kolkata', 'Asia/Kolkata', NOW)).toBeNull();
  });

  it('a zone with daylight saving against one without still reports the shifts', () => {
    const g = gapNotice('Asia/Kolkata', 'America/New_York', NOW);
    expect(g?.now).toBe('New York is 9h 30m behind Kolkata');
    expect(g?.changes).toEqual(['New York is 10h 30m behind Kolkata from 1 Nov']);
  });
});

describe('clock change lines', () => {
  it('merges roles per zone and states when each zone next changes', () => {
    const lines = clockChangeLines(
      [
        { zone: 'America/New_York', role: 'Highlighted' },
        { zone: 'Europe/Lisbon', role: 'My zone' },
        { zone: 'America/New_York', role: 'Client zone' },
      ],
      NOW,
    );
    expect(lines.map((l) => [l.zone, l.roles])).toEqual([
      ['America/New_York', ['Highlighted', 'Client zone']],
      ['Europe/Lisbon', ['My zone']],
    ]);
    expect(lines[0]?.text).toMatch(/^New York clocks (go|went) back 1h, 1 Nov$/);
    expect(lines[1]?.text).toMatch(/^Lisbon clocks (go|went) forward 1h, 29 Mar$/);
    expect(lines.every((l) => l.hasChange)).toBe(true);
  });

  it('says nothing is scheduled for zones without clock changes', () => {
    const lines = clockChangeLines(
      [
        { zone: 'Asia/Kolkata', role: 'Highlighted' },
        { zone: 'UTC', role: 'My zone' },
        { zone: 'America/Phoenix', role: 'Client zone' },
      ],
      NOW,
    );
    for (const l of lines) {
      expect(l.hasChange).toBe(false);
      expect(l.text).toBe('No clock change is scheduled.');
    }
  });

  it('adds the year when the change is not in the current year', () => {
    const lines = clockChangeLines([{ zone: 'America/New_York', role: 'My zone' }], parseIso('2026-11-15T12:00:00Z'));
    expect(lines[0]?.text).toMatch(/forward 1h, 14 Mar 2027$/);
    expect(dateText(parseIso('2027-03-14T07:00:00Z'), 'America/New_York', NOW)).toBe('14 Mar 2027');
    expect(dateText(parseIso('2026-11-01T06:00:00Z'), 'America/New_York', NOW)).toBe('1 Nov');
  });
});
