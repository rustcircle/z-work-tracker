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

describe('R16: a field that was not touched keeps the instant it was made from', () => {
  // 09:00:37 in Lisbon on 12 March 2026, which is UTC+0 then. A date and a time input hold minutes only.
  const kept = utc('2026-03-12T09:00:37Z');

  it('gives back that instant, seconds and all, while the fields still show its minute', () => {
    const field = fieldFromInstant(kept, zone);
    expect(field).toEqual({ day: '2026-03-12', time: '09:00', second: false });
    expect(wallToInstant(field, zone, 'Start', kept)).toEqual({ ok: true, at: kept });
  });

  it('resolves the fields as before once the day or the time was changed', () => {
    const field = fieldFromInstant(kept, zone);
    expect(wallToInstant({ ...field, time: '09:01' }, zone, 'Start', kept)).toEqual({ ok: true, at: utc('2026-03-12T09:01:00Z') });
    expect(wallToInstant({ ...field, day: '2026-03-11' }, zone, 'Start', kept)).toEqual({ ok: true, at: utc('2026-03-11T09:00:00Z') });
  });

  it('counts a change back to the minute shown as no change', () => {
    const field = fieldFromInstant(kept, zone);
    const there = { ...field, time: '09:05' };
    expect(wallToInstant(there, zone, 'Start', kept)).toEqual({ ok: true, at: utc('2026-03-12T09:05:00Z') });
    expect(wallToInstant({ ...there, time: '09:00' }, zone, 'Start', kept)).toEqual({ ok: true, at: kept });
  });

  it('keeps the second pass of a repeated hour while it is the one chosen, and resolves the first when that is chosen', () => {
    const second = utc('2026-10-25T01:30:41Z');
    const field = fieldFromInstant(second, zone);
    expect(field.second).toBe(true);
    expect(wallToInstant(field, zone, 'Start', second)).toEqual({ ok: true, at: second });
    expect(wallToInstant({ ...field, second: false }, zone, 'Start', second)).toEqual({ ok: true, at: utc('2026-10-25T00:30:00Z') });
  });

  it('still refuses a wall time that does not exist, whatever instant was kept', () => {
    const field = fieldFromInstant(kept, zone);
    expect(wallToInstant({ ...field, day: '2026-03-29', time: '01:30' }, zone, 'Start', kept)).toEqual({ ok: false, message: expect.stringContaining('does not exist') });
  });

  it('without a kept instant a field is resolved to its minute, as every other form does', () => {
    expect(wallToInstant(fieldFromInstant(kept, zone), zone, 'Start')).toEqual({ ok: true, at: utc('2026-03-12T09:00:00Z') });
  });
});
