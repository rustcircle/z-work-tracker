// `settle_lost_segment` on the mock follows `Service::settle_lost_segment`: a blank reason takes the default text, and a computer's
// silence is measured from when it last wrote its file, not from the heartbeat of the segment it left running.
import { describe, expect, it } from 'vitest';

import { parseIso, toIso } from '../lib/tz';
import type { AuditEntry, Snapshot } from '../lib/types';
import { demoState } from './demoSeed';
import { OTHER_DEVICE_ID, handle, type MockState } from './ipcMock';

const call = <T,>(s: MockState, cmd: string, a: Record<string, unknown> = {}) => handle(s, cmd, a) as T;
const fails = (s: MockState, cmd: string, a: Record<string, unknown> = {}) => {
  try {
    handle(s, cmd, a);
  } catch (e) {
    return e as { code: string; message: string };
  }
  throw new Error(`${cmd} did not fail`);
};

const NOW = parseIso('2026-03-12T15:20:00Z');
const ago = (secs: number): string => toIso(NOW - secs);
const MOCK_PC = 'Mock PC';
const DEFAULT = `Closed from ${MOCK_PC}: Office PC stopped responding. Ended at its last known moment.`;

/** "Email and invoices" left running on Office PC, started three days ago and last heard of two days ago. */
function abandoned(): MockState {
  const s = demoState();
  const t = s.tasks.find((x) => x.id === 't-mail');
  if (!t) throw new Error('no task');
  t.state = 'running';
  t.runningElsewhere = 'Office PC';
  s.segments.push({ id: 'seg-old', taskId: 't-mail', deviceId: OTHER_DEVICE_ID, start: ago(3 * 86_400), end: null, provisionalEnd: ago(2 * 86_400) });
  s.remoteDevices = { [OTHER_DEVICE_ID]: { name: 'Office PC', writtenAt: ago(2 * 86_400) } };
  return s;
}

const settledReason = (out: Snapshot): string | undefined => out.rawSegments.find((x) => x.id === 'seg-old')?.reason;

describe('settle_lost_segment: the reason', () => {
  it.each([[''], ['   '], ['\n']])('a blank reason (%j) takes the backend’s default text', (blank) => {
    const s = abandoned();
    expect(settledReason(call<Snapshot>(s, 'settle_lost_segment', { segmentId: 'seg-old', reason: blank }))).toBe(DEFAULT);
  });

  it('keeps a reason that was typed, and the audit trail says the same', () => {
    const s = abandoned();
    const out = call<Snapshot>(s, 'settle_lost_segment', { segmentId: 'seg-old', reason: 'The office PC was scrapped' });
    expect(settledReason(out)).toBe('The office PC was scrapped');
    const log = call<AuditEntry[]>(s, 'get_audit', { entityId: 'seg-old' });
    expect(log.filter((e) => e.action === 'settleLost').map((e) => e.reason)).toEqual(['The office PC was scrapped']);
  });

  it('names the computer the segment belongs to, as the backend knows it', () => {
    const s = abandoned();
    must(s.remoteDevices)[OTHER_DEVICE_ID] = { name: 'Studio iMac', writtenAt: ago(2 * 86_400) };
    expect(settledReason(call<Snapshot>(s, 'settle_lost_segment', { segmentId: 'seg-old', reason: '' }))).toBe(DEFAULT.replace('Office PC', 'Studio iMac'));
  });

  it('still refuses a reason the backend would not store', () => {
    expect(fails(abandoned(), 'settle_lost_segment', { segmentId: 'seg-old', reason: 'x'.repeat(501) }).code).toBe('validation');
  });
});

describe('settle_lost_segment: how long the other computer has been silent', () => {
  it('counts from when it last wrote its file, not from the heartbeat of the segment', () => {
    const s = abandoned();
    // Its segment was last heard of two days ago, but it wrote its file ten minutes ago: it is plainly still there.
    must(s.remoteDevices)[OTHER_DEVICE_ID] = { name: 'Office PC', writtenAt: ago(10 * 60) };
    expect(fails(s, 'settle_lost_segment', { segmentId: 'seg-old', reason: '' })).toEqual({ code: 'conflict', message: 'Office PC was seen 10 min ago, so it may still be running this' });
    expect(s.segments.find((x) => x.id === 'seg-old')?.edit).toBeFalsy();
  });

  it('allows it from exactly a day', () => {
    const s = abandoned();
    must(s.remoteDevices)[OTHER_DEVICE_ID] = { name: 'Office PC', writtenAt: ago(86_400 - 1) };
    expect(fails(s, 'settle_lost_segment', { segmentId: 'seg-old', reason: '' }).code).toBe('conflict');
    must(s.remoteDevices)[OTHER_DEVICE_ID] = { name: 'Office PC', writtenAt: ago(86_400) };
    expect(() => call(s, 'settle_lost_segment', { segmentId: 'seg-old', reason: '' })).not.toThrow();
  });

  it('counts a computer it has never read a file from as silent since the segment began', () => {
    const s = abandoned();
    s.remoteDevices = undefined;
    // Began three days ago: long enough.
    expect(() => call(s, 'settle_lost_segment', { segmentId: 'seg-old', reason: '' })).not.toThrow();
    // Began 20 minutes ago: not yet, and it is named as the task card names it.
    const t = abandoned();
    t.remoteDevices = undefined;
    const seg = must(t.segments.find((x) => x.id === 'seg-old'));
    seg.start = ago(20 * 60);
    seg.provisionalEnd = ago(60);
    expect(fails(t, 'settle_lost_segment', { segmentId: 'seg-old', reason: '' }).message).toBe('Office PC was seen 20 min ago, so it may still be running this');
  });

  it('says “another device” when nothing names it', () => {
    const s = abandoned();
    s.remoteDevices = undefined;
    must(s.tasks.find((x) => x.id === 't-mail')).runningElsewhere = null;
    must(s.segments.find((x) => x.id === 'seg-old')).start = ago(5 * 60);
    expect(fails(s, 'settle_lost_segment', { segmentId: 'seg-old', reason: '' }).message).toBe('another device was seen 5 min ago, so it may still be running this');
  });

  it('is not needed once the computer was asked to pause, whenever it last wrote', () => {
    const s = abandoned();
    must(s.remoteDevices)[OTHER_DEVICE_ID] = { name: 'Office PC', writtenAt: ago(60) };
    call(s, 'request_remote_pause', { taskId: 't-mail' });
    expect(() => call(s, 'settle_lost_segment', { segmentId: 'seg-old', reason: '' })).not.toThrow();
  });

  it.each([
    [20, 'less than a minute'],
    [60, '1 min'],
    [45 * 60, '45 min'],
    [2 * 3600, '2 h'],
    [3600 + 5 * 60, '1 h 5 min'],
    [23 * 3600 + 59 * 60, '23 h 59 min'],
  ])('says a silence of %i seconds as “%s”, the way the backend does', (secs, text) => {
    const s = abandoned();
    must(s.remoteDevices)[OTHER_DEVICE_ID] = { name: 'Office PC', writtenAt: ago(secs) };
    expect(fails(s, 'settle_lost_segment', { segmentId: 'seg-old', reason: '' }).message).toBe(`Office PC was seen ${text} ago, so it may still be running this`);
  });
});

function must<T>(value: T | undefined | null): T {
  if (value === undefined || value === null) throw new Error('missing');
  return value;
}
