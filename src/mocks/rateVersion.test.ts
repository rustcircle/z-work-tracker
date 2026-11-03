// Removing a price version, and the bounds on a date someone chose, in the mock. Both are shaped like the Rust
// service (machine.rs `delete_rate_version` and `set_rate`, validate.rs `check_chosen_date`), error text included,
// so a UI test that passes here says something about the real backend.
import { clearMocks, mockIPC } from '@tauri-apps/api/mocks';
import { afterEach, describe, expect, it } from 'vitest';

import { api } from '../lib/api';
import type { Snapshot, WithId } from '../lib/types';
import { emptyState, handle, type MockState } from './ipcMock';

afterEach(() => clearMocks());

const call = <T,>(s: MockState, cmd: string, a: Record<string, unknown> = {}) => handle(s, cmd, a) as T;
const fails = (s: MockState, cmd: string, a: Record<string, unknown>) => {
  try {
    handle(s, cmd, a);
  } catch (e) {
    return e as { code: string; message: string };
  }
  throw new Error(`${cmd} did not fail`);
};

const BOUND = 'must be between 2000-01-01 and 2100-01-01';

/** 12 March 2026, one project with a price that started in January and one that starts in April. */
function world() {
  const s = emptyState('2026-03-12T12:00:00Z');
  const { id: projectId } = call<WithId>(s, 'create_project', { input: { name: 'Acme', color: '#2563EB', billable: true, budgetHours: null, clientZone: null } });
  const rate = (rateCents: number, effectiveFrom: string) => call<Snapshot>(s, 'set_rate', { input: { projectId, rateCents, currency: 'EUR', effectiveFrom, confirmRetroactive: true } });
  rate(6000, '2026-01-01T00:00:00Z');
  rate(7000, '2026-04-01T00:00:00Z');
  const ids = Object.fromEntries(s.rates.map((r) => [r.effectiveFrom, r.id])) as Record<string, string>;
  return { s, projectId, started: ids['2026-01-01T00:00:00Z'] as string, ahead: ids['2026-04-01T00:00:00Z'] as string };
}

describe('delete_rate_version in the mock', () => {
  it('is a command of the api, with the arguments the backend takes', async () => {
    // lib.rs: `delete_rate_version(id, confirm_retroactive)`, which Tauri reads as `id` and `confirmRetroactive`.
    const seen: { cmd: string; args: unknown }[] = [];
    mockIPC((cmd, args) => {
      seen.push({ cmd, args });
      return null;
    });
    await api.deleteRateVersion('v1', true);
    await api.deleteRateVersion('v2', false);
    expect(seen).toEqual([
      { cmd: 'delete_rate_version', args: { id: 'v1', confirmRetroactive: true } },
      { cmd: 'delete_rate_version', args: { id: 'v2', confirmRetroactive: false } },
    ]);
  });

  it('refuses a price that has started until the change of past earnings is confirmed, and then the one before applies again', () => {
    const { s, projectId, started } = world();
    const refused = fails(s, 'delete_rate_version', { id: started, confirmRetroactive: false });
    expect(refused.code).toBe('conflict');
    expect(refused.message).toBe('taking away a price that has started changes past earnings and needs confirmation');
    expect(s.rates.find((r) => r.id === started)?.deleted).toBe(false);
    const after = call<Snapshot>(s, 'delete_rate_version', { id: started, confirmRetroactive: true });
    expect(after.rates.map((r) => r.id)).not.toContain(started);
    expect(after.rates.filter((r) => r.projectId === projectId)).toHaveLength(1);
  });

  it('needs no confirmation for a price that has not started', () => {
    const { s, ahead, started } = world();
    const after = call<Snapshot>(s, 'delete_rate_version', { id: ahead, confirmRetroactive: false });
    expect(after.rates.map((r) => r.id)).toEqual([started]);
  });

  it('leaves a tombstone, so a version goes only once, and writes the audit line the backend writes', () => {
    const { s, ahead, projectId } = world();
    call(s, 'delete_rate_version', { id: ahead, confirmRetroactive: false });
    expect(s.rates.find((r) => r.id === ahead)?.deleted).toBe(true);
    const again = fails(s, 'delete_rate_version', { id: ahead, confirmRetroactive: true });
    expect(again).toEqual({ code: 'not_found', message: 'price version not found' });
    const lines = s.audit.filter((e) => e.entity === 'price' && e.entityId === ahead);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ action: 'removed', before: { projectId, effectiveFrom: '2026-04-01T00:00:00Z', rateCents: 7000, currency: 'EUR' }, after: null });
  });

  it('says not found for an id nobody has', () => {
    const { s } = world();
    expect(fails(s, 'delete_rate_version', { id: 'nope', confirmRetroactive: true })).toEqual({ code: 'not_found', message: 'price version not found' });
  });
});

describe('a date someone chose, in the mock, is held to the limits of the backend', () => {
  it('set_rate refuses a start date before 2000 or after 2100, with the backend text, and takes the limits themselves', () => {
    const { s, projectId } = world();
    const set = (effectiveFrom: string) => ({ input: { projectId, rateCents: 8000, currency: 'EUR', effectiveFrom, confirmRetroactive: true } });
    for (const bad of ['1999-12-31T23:59:59Z', '2100-01-01T00:00:01Z', '2150-06-01T00:00:00Z', '0099-01-01T00:00:00Z']) {
      expect(fails(s, 'set_rate', set(bad)), bad).toEqual({ code: 'validation', message: `the price's start date ${BOUND}` });
    }
    expect(s.rates.map((r) => r.effectiveFrom).sort()).toEqual(['2026-01-01T00:00:00Z', '2026-04-01T00:00:00Z']);
    call(s, 'set_rate', set('2000-01-01T00:00:00Z'));
    call(s, 'set_rate', set('2100-01-01T00:00:00Z'));
    expect(s.rates.map((r) => r.effectiveFrom)).toEqual(expect.arrayContaining(['2000-01-01T00:00:00Z', '2100-01-01T00:00:00Z']));
  });

  it('a manual entry that starts before 2000 is refused with the backend text', () => {
    const { s, projectId } = world();
    const { id: taskId } = call<WithId>(s, 'create_task', { input: { name: 'T', projectId, description: null, tags: ['tag-admin'] } });
    const e = fails(s, 'add_manual_entry', { input: { taskId, start: '1999-12-31T22:00:00Z', end: '2026-03-12T10:00:00Z', reason: 'x', allowOverlap: false } });
    expect(e).toEqual({ code: 'validation', message: `the start ${BOUND}` });
    expect(s.segments).toEqual([]);
  });
});

// machine.rs `set_rate` checks in this order: the project, the date (parsed, then within the limits), the backdating
// confirmation, and only then the price and its currency. It keeps one live version per project and instant.
describe('set_rate in the mock follows the order and the effects of the backend', () => {
  const rate = (projectId: string, over: Record<string, unknown> = {}) => ({ input: { projectId, rateCents: 100, currency: 'EUR', ...over } });

  it('refuses a project that is not there, and leaves no price behind', () => {
    const { s } = world();
    const before = s.rates.length;
    expect(fails(s, 'set_rate', rate('nope'))).toEqual({ code: 'not_found', message: 'project not found' });
    expect(s.rates).toHaveLength(before);
  });

  it('refuses a project that was deleted', () => {
    const { s, projectId } = world();
    call(s, 'delete_project', { id: projectId });
    expect(fails(s, 'set_rate', rate(projectId))).toEqual({ code: 'not_found', message: 'project not found' });
  });

  it('says a date it cannot read is invalid, with a code, instead of failing in the date arithmetic', () => {
    const { s, projectId } = world();
    expect(fails(s, 'set_rate', rate(projectId, { effectiveFrom: 'garbage', confirmRetroactive: true }))).toEqual({ code: 'validation', message: 'invalid effective date' });
  });

  it('asks for the confirmation of a backdated price before it looks at the currency', () => {
    const { s, projectId } = world();
    const e = fails(s, 'set_rate', rate(projectId, { currency: 'GBP', effectiveFrom: '2026-01-01T00:00:00Z', confirmRetroactive: false }));
    expect(e.code).toBe('conflict');
    expect(e.message).toBe('a backdated price changes past earnings and needs confirmation');
  });

  it('still refuses a currency and a price the backend refuses, once the date is in order', () => {
    const { s, projectId } = world();
    expect(fails(s, 'set_rate', rate(projectId, { currency: 'GBP' }))).toEqual({ code: 'validation', message: 'currency must be EUR or USD' });
    expect(fails(s, 'set_rate', rate(projectId, { rateCents: 1_000_001 }))).toEqual({ code: 'validation', message: 'price per hour must be between 0 and 10000.00' });
  });

  it('setting a price again for the same instant keeps the version and changes its price', () => {
    const { s, projectId, ahead } = world();
    call(s, 'set_rate', rate(projectId, { rateCents: 9100, effectiveFrom: '2026-04-01T00:00:00Z' }));
    const at = s.rates.filter((r) => r.projectId === projectId && r.effectiveFrom === '2026-04-01T00:00:00Z');
    expect(at).toHaveLength(1);
    expect(at[0]).toMatchObject({ id: ahead, rateCents: 9100, deleted: false });
  });

  it('a version taken away stays a tombstone when a price is set again for its instant', () => {
    const { s, projectId, ahead } = world();
    call(s, 'delete_rate_version', { id: ahead, confirmRetroactive: false });
    call(s, 'set_rate', rate(projectId, { rateCents: 9200, effectiveFrom: '2026-04-01T00:00:00Z' }));
    expect(s.rates.find((r) => r.id === ahead)?.deleted).toBe(true);
    const live = s.rates.filter((r) => r.projectId === projectId && r.effectiveFrom === '2026-04-01T00:00:00Z' && !r.deleted);
    expect(live).toHaveLength(1);
    expect(live[0]).toMatchObject({ rateCents: 9200 });
    expect(live[0]?.id).not.toBe(ahead);
  });
});
