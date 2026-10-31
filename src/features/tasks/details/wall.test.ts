import { describe, expect, it } from 'vitest';

import { fieldFromInstant, repeated, resolveWall, wallToInstant } from './wall';

// Lisbon: clocks went forward at 01:00 UTC on 29 Mar 2026 (01:00 WET became 02:00 WEST) and back at 01:00 UTC on 25 Oct 2026.
const zone = 'Europe/Lisbon';
const utc = (iso: string): number => Date.parse(iso) / 1000;

describe('wall clock to instant', () => {
  it('an ordinary time maps to one instant, with the offset in force that day', () => {
    expect(resolveWall('2026-03-12', '14:30', zone)).toEqual({ kind: 'ok', at: utc('2026-03-12T14:30:00Z') });
    expect(resolveWall('2026-07-01', '14:30', zone)).toEqual({ kind: 'ok', at: utc('2026-07-01T13:30:00Z') });
    expect(resolveWall('2026-07-01', '14:30', 'America/New_York')).toEqual({ kind: 'ok', at: utc('2026-07-01T18:30:00Z') });
  });

  it('a time that clocks skip is reported as a gap, with the jump', () => {
    const r = resolveWall('2026-03-29', '01:30', zone);
    expect(r).toMatchObject({ kind: 'gap', from: '01:00', to: '02:00', at: utc('2026-03-29T01:00:00Z') });
    const wall = wallToInstant({ day: '2026-03-29', time: '01:30', second: false }, zone, 'Start');
    expect(wall).toEqual({ ok: false, message: expect.stringContaining('does not exist') });
    expect(resolveWall('2026-03-29', '02:00', zone)).toMatchObject({ kind: 'ok' });
    expect(resolveWall('2026-03-29', '00:59', zone)).toMatchObject({ kind: 'ok' });
  });

  it('a time that happens twice gives both instants and honours the choice', () => {
    const r = resolveWall('2026-10-25', '01:30', zone);
    expect(r).toEqual({ kind: 'overlap', first: utc('2026-10-25T00:30:00Z'), second: utc('2026-10-25T01:30:00Z') });
    expect(wallToInstant({ day: '2026-10-25', time: '01:30', second: false }, zone, 'Start')).toEqual({ ok: true, at: utc('2026-10-25T00:30:00Z') });
    expect(wallToInstant({ day: '2026-10-25', time: '01:30', second: true }, zone, 'Start')).toEqual({ ok: true, at: utc('2026-10-25T01:30:00Z') });
    expect(repeated({ day: '2026-10-25', time: '01:30', second: false }, zone)).not.toBeNull();
    expect(repeated({ day: '2026-10-25', time: '03:30', second: false }, zone)).toBeNull();
  });

  it('a 30 minute zone offset and a 45 minute one work too', () => {
    expect(resolveWall('2026-03-12', '12:00', 'Asia/Kolkata')).toEqual({ kind: 'ok', at: utc('2026-03-12T06:30:00Z') });
    expect(resolveWall('2026-03-12', '12:00', 'Asia/Kathmandu')).toEqual({ kind: 'ok', at: utc('2026-03-12T06:15:00Z') });
  });

  it('refuses dates and times that do not exist', () => {
    expect(resolveWall('2026-02-31', '10:00', zone).kind).toBe('invalid');
    expect(resolveWall('', '10:00', zone).kind).toBe('invalid');
    expect(resolveWall('2026-02-10', '', zone).kind).toBe('invalid');
    expect(resolveWall('2026-02-10', '25:00', zone).kind).toBe('invalid');
  });

  it('round-trips an instant through the form fields, including the second pass of a repeated hour', () => {
    for (const iso of ['2026-03-12T14:30:00Z', '2026-10-25T00:30:00Z', '2026-10-25T01:30:00Z', '2026-03-29T00:59:00Z', '2026-03-29T01:00:00Z']) {
      const field = fieldFromInstant(utc(iso), zone);
      expect(wallToInstant(field, zone, 'Start')).toEqual({ ok: true, at: utc(iso) });
    }
    expect(fieldFromInstant(utc('2026-10-25T01:30:00Z'), zone)).toEqual({ day: '2026-10-25', time: '01:30', second: true });
  });
});
