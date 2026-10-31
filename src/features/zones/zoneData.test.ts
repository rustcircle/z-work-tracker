import { describe, expect, it } from 'vitest';
import tzlookup from '@photostructure/tz-lookup';

import { isZone, offsetAt, parseIso, pickerZones } from '../../lib/tz';
import { buildRows, filterRows, LEGACY_ALIASES, listedZones } from './zoneData';

const JULY = parseIso('2026-07-01T12:00:00Z');
const JANUARY = parseIso('2026-01-15T12:00:00Z');

describe('zone list', () => {
  it('hides only obsolete spellings, each of which has the same offsets as its current name', () => {
    const listed = new Set(listedZones());
    const all = pickerZones();
    expect(listed.size).toBe(all.length - Object.keys(LEGACY_ALIASES).length);
    for (const [alias, current] of Object.entries(LEGACY_ALIASES)) {
      expect(isZone(alias), alias).toBe(true);
      expect(isZone(current), current).toBe(true);
      expect(listed.has(alias), alias).toBe(false);
      expect(listed.has(current), current).toBe(true);
      for (const t of [JANUARY, JULY]) expect(offsetAt(t, alias), alias).toBe(offsetAt(t, current));
    }
    expect(listed.has('UTC')).toBe(true);
    expect(listed.has('Europe/Monaco')).toBe(true);
  });

  it('lists every zone the map lookup can return, and never hides one', () => {
    const listed = new Set(listedZones());
    const seen = new Set<string>();
    for (let lat = -89.9; lat < 90; lat += 0.1) {
      for (let lon = -179.9; lon < 180; lon += 0.1) seen.add(tzlookup(lat, lon));
    }
    // Every name the lookup package can return (ocean bands included) exists in the app's zone data, so no mapping is needed.
    for (const z of seen) expect(isZone(z), z).toBe(true);
    const named = [...seen].filter((z) => !z.startsWith('Etc/'));
    expect(named.length).toBeGreaterThan(350);
    for (const z of named) expect(listed.has(z), z).toBe(true);
    for (const alias of Object.keys(LEGACY_ALIASES)) expect(seen.has(alias), alias).toBe(false);
  });
});

describe('zone search', () => {
  const rows = buildRows(listedZones(), JULY);
  const find = (q: string) => filterRows(rows, q).map((r) => r.zone);

  it('describes each row with the abbreviation, offset and local time in force at that instant', () => {
    const ny = rows.find((r) => r.zone === 'America/New_York');
    expect(ny).toMatchObject({ city: 'New York', abbr: 'EDT', offsetText: 'UTC-4', clock: '08:00', path: 'America/New York' });
    const kt = rows.find((r) => r.zone === 'Asia/Kathmandu');
    expect(kt).toMatchObject({ offsetText: 'UTC+5:45', clock: '17:45' });
    const winter = buildRows(['America/New_York'], JANUARY)[0];
    expect(winter).toMatchObject({ abbr: 'EST', offsetText: 'UTC-5', clock: '07:00' });
  });

  it('finds by city, with city-name matches first', () => {
    expect(find('lisbon')[0]).toBe('Europe/Lisbon');
    expect(find('new york')[0]).toBe('America/New_York');
    expect(find('york')).toContain('America/New_York');
  });

  it('finds by zone path and by region', () => {
    expect(find('america/chicago')[0]).toBe('America/Chicago');
    expect(find('europe')).toEqual(expect.arrayContaining(['Europe/Lisbon', 'Europe/Berlin']));
    for (const z of listedZones().filter((x) => x.startsWith('Europe/'))) expect(find('europe')).toContain(z);
    expect(find('america/new_york')[0]).toBe('America/New_York');
    expect(find('america/new york')[0]).toBe('America/New_York');
  });

  it('finds by abbreviation and by current offset in several spellings', () => {
    expect(find('edt')).toEqual(expect.arrayContaining(['America/New_York', 'America/Toronto']));
    expect(find('edt')).not.toContain('America/Chicago');
    expect(find('utc+5:45')).toEqual(['Asia/Kathmandu']);
    expect(find('+5:30')).toEqual(expect.arrayContaining(['Asia/Kolkata']));
    expect(find('utc-4')).toContain('America/New_York');
    expect(find('utc-4')).not.toContain('America/Chicago');
    expect(find('-04:00')).toContain('America/New_York');
  });

  it('finds the current entry by an obsolete spelling', () => {
    expect(find('calcutta')).toEqual(['Asia/Kolkata']);
    expect(find('katmandu')).toEqual(['Asia/Kathmandu']);
  });

  it('requires every word, ignores case and extra spaces, and returns nothing for gibberish', () => {
    expect(find('  NEW   york ')[0]).toBe('America/New_York');
    expect(find('york lisbon')).toEqual([]);
    expect(find('zzzzqx')).toEqual([]);
    expect(find('').length).toBe(rows.length);
  });
});
