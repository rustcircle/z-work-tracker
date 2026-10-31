// The mock must answer like the backend for everything the gap-fill round added: colour replacement, selective
// export validation, remote pause requests, reverting a shift version, the setup state and drafts.
import { describe, expect, it } from 'vitest';

import type { SavedColor, Snapshot } from '../lib/types';
import { demoP2State, demoState } from './demoSeed';
import { fullProject, nextProjectColor } from './factories';
import { DEVICE_ID, emptyState, handle, type MockState } from './ipcMock';

const call = <T,>(s: MockState, cmd: string, a: Record<string, unknown> = {}) => handle(s, cmd, a) as T;
const fails = (s: MockState, cmd: string, a: Record<string, unknown>) => {
  try {
    handle(s, cmd, a);
  } catch (e) {
    return e as { code: string; message: string };
  }
  throw new Error(`${cmd} did not fail`);
};
const input = (name: string, color: string) => ({ name, color, billable: true, budgetHours: null, clientZone: null });

describe('project and tag colours', () => {
  it('replaces an exact clash with another active project, whatever the case, and says what it asked for', () => {
    const s = emptyState();
    call<SavedColor>(s, 'create_project', { input: input('A', '#2563eb') });
    const b = call<SavedColor>(s, 'create_project', { input: input('B', '#2563EB') });
    expect(b.replacedFrom).toBe('#2563eb');
    expect(b.color).not.toBe('#2563eb');
    expect(s.projects.find((p) => p.id === b.id)?.color).toBe(b.color);
    expect(b.snapshot.projects.map((p) => p.color)).toContain(b.color);
  });

  it('does not touch a similar colour, an archived project, or a colour left unchanged on update', () => {
    const s = emptyState();
    const a = call<SavedColor>(s, 'create_project', { input: input('A', '#2563eb') });
    expect(call<SavedColor>(s, 'create_project', { input: input('Similar', '#2563ec') }).replacedFrom).toBeNull();
    call(s, 'set_project_archived', { id: a.id, archived: true });
    expect(call<SavedColor>(s, 'create_project', { input: input('Reuses archived', '#2563eb') })).toMatchObject({ replacedFrom: null, color: '#2563eb' });
    // Two projects ended up with one colour (a merge): saving one of them again keeps it.
    const twin = call<SavedColor>(s, 'update_project', { id: a.id, input: input('A', '#2563eb') });
    expect(twin.replacedFrom).toBeNull();
    expect(twin.color).toBe('#2563eb');
  });

  it('keeps merged duplicates as they are and warns about them', () => {
    const s = demoState();
    const proj = s.projects[1];
    if (!proj) throw new Error('seed');
    proj.color = s.projects[0]?.color ?? '';
    const snap = call<Snapshot>(s, 'get_snapshot');
    expect(snap.warnings.some((w) => w.includes('same colour'))).toBe(true);
    expect(snap.projects[1]?.color).toBe(snap.projects[0]?.color);
  });

  it('applies the same rule to tags, within tags only', () => {
    const s = emptyState();
    const project = call<SavedColor>(s, 'create_project', { input: input('P', '#7c3aed') });
    expect(project.replacedFrom).toBeNull();
    // '#7c3aed' is also the starter tag Concept's colour: a project and a tag never clash with each other.
    const t = call<SavedColor>(s, 'save_tag', { input: { name: 'New', color: '#7C3AED' } });
    expect(t.replacedFrom).toBe('#7c3aed');
    expect(t.color).not.toBe('#7c3aed');
    const same = call<SavedColor>(s, 'save_tag', { input: { id: t.id, name: 'New', color: t.color } });
    expect(same.replacedFrom).toBeNull();
  });

  it('is random but injectable', () => {
    const run = (seedValue: number) => {
      const s = emptyState();
      s.random = () => seedValue;
      call(s, 'create_project', { input: input('A', '#2563eb') });
      return call<SavedColor>(s, 'create_project', { input: input('B', '#2563eb') }).color;
    };
    expect(run(0.25)).toBe(run(0.25));
  });
});

describe('seed data never shares a project colour', () => {
  const colorsOf = (s: MockState) => s.projects.map((p) => p.color.toLowerCase());
  it('in the demo, the phase 2 demo and the test factory', () => {
    for (const s of [demoState(), demoP2State()]) expect(new Set(colorsOf(s)).size).toBe(s.projects.length);
    const made = Array.from({ length: 40 }, (_, i) => fullProject({ id: `f${i}` }).color.toLowerCase());
    expect(new Set(made).size).toBe(made.length);
    expect(made).not.toContain(nextProjectColor().toLowerCase());
  });
});

describe('selective export', () => {
  const world = () => {
    const s = demoState();
    return s;
  };
  const request = (selection: unknown) => ({ request: { dayZone: 'Europe/Lisbon', myZone: 'Europe/Lisbon', clientZone: null, includeEarnings: true, segmentShifts: {}, analytics: [], selection } });

  it('refuses an empty selection, an unknown task and a task-day with no time, and accepts a real one', () => {
    const s = world();
    expect(fails(s, 'export_xlsx', request([])).message).toMatch(/at least one/);
    expect(fails(s, 'export_csv', request([{ taskId: 'nope', day: '2026-03-10' }])).code).toBe('not_found');
    expect(fails(s, 'export_xlsx', request([{ taskId: 't-logo', day: '2026-01-01' }])).message).toMatch(/no time on 2026-01-01/);
    call(s, 'export_xlsx', request([{ taskId: 't-logo', day: '2026-03-12' }]));
    expect(s.exports.at(-1)?.request.selection).toEqual([{ taskId: 't-logo', day: '2026-03-12' }]);
    call(s, 'export_csv', request(null));
    expect(s.exports.at(-1)?.request.selection).toBeNull();
  });

  it('validates a PDF selection too, in the PDF zone, and records it', () => {
    const s = world();
    const pdf = (selection: unknown, zone = 'Europe/Lisbon') => ({ request: { projectId: null, from: '2026-03-01', to: '2026-03-31', zone, title: 'T', includePrices: true, useLogo: false, selection } });
    expect(fails(s, 'export_pdf', pdf([])).message).toMatch(/at least one/);
    call(s, 'export_pdf', pdf([{ taskId: 't-home', day: '2026-03-11' }]));
    expect(s.pdfExports.at(-1)?.selection).toEqual([{ taskId: 't-home', day: '2026-03-11' }]);
  });
});

describe('remote pause, shift versions, setup and drafts', () => {
  it('asks another device to pause, once per open segment, and refuses a task running here', () => {
    const s = demoState();
    expect(fails(s, 'request_remote_pause', { taskId: 't-logo' }).code).toBe('conflict');
    const t = s.tasks.find((x) => x.id === 't-logo');
    const open = s.segments.find((x) => x.taskId === 't-logo' && x.end === null);
    if (!t || !open) throw new Error('seed');
    open.deviceId = 'other-device';
    t.runningElsewhere = 'Office PC';
    const snap = call<Snapshot>(s, 'request_remote_pause', { taskId: 't-logo' });
    expect(snap.pauseRequests).toHaveLength(1);
    expect(snap.pauseRequests[0]).toMatchObject({ taskId: 't-logo', segmentId: open.id, requestedBy: DEVICE_ID });
    expect(call<Snapshot>(s, 'request_remote_pause', { taskId: 't-logo' }).pauseRequests).toHaveLength(1);
    // That device's own record is untouched.
    expect(open.end).toBeNull();
  });

  it('reverts one shift version but never the only one', () => {
    const s = demoState();
    expect(fails(s, 'revert_shift_version', { versionId: 'sv1' }).code).toBe('conflict');
    call(s, 'save_shift', { input: { shiftId: 'sh-morning', effectiveFrom: '2026-03-01', name: 'Morning', color: '#0891b2', start: '08:00', end: '12:00', weekdays: [1], zone: 'Europe/Lisbon', breakMinutes: 0 } });
    const live = () => call<Snapshot>(s, 'get_snapshot').shifts.filter((v) => v.shiftId === 'sh-morning');
    expect(live()).toHaveLength(2);
    const newest = live().find((v) => v.effectiveFrom === '2026-03-01');
    call(s, 'revert_shift_version', { versionId: newest?.id });
    expect(live().map((v) => v.id)).toEqual(['sv1']);
    expect(fails(s, 'revert_shift_version', { versionId: 'missing' }).code).toBe('not_found');
  });

  it('shows setup only on a fresh store, remembers the step, and answers the old prompts when finished', () => {
    const s = emptyState();
    expect(call<Snapshot>(s, 'get_snapshot').setup).toEqual({ pending: false, step: 0 });
    s.setupDone = false;
    s.syncPromptDone = false;
    s.clientZonePromptDone = false;
    expect(call<Snapshot>(s, 'get_snapshot').setup).toEqual({ pending: true, step: 0 });
    expect(call<Snapshot>(s, 'set_setup_step', { step: 3 }).setup).toEqual({ pending: true, step: 3 });
    const done = call<Snapshot>(s, 'finish_setup');
    expect(done.setup.pending).toBe(false);
    expect(done.sync.promptPending).toBe(false);
    expect(done.prefs.clientZonePromptDone).toBe(true);
  });

  it('connecting a sync folder ends "pending" like the backend, so the wizard must not depend on it alone', () => {
    const s = emptyState();
    s.setupDone = false;
    s.syncPromptDone = false;
    call(s, 'add_sync_target', { provider: 'oneDrive', root: 'C:\\OneDrive' });
    expect(call<Snapshot>(s, 'get_snapshot').setup.pending).toBe(false);
  });

  it('keeps drafts in a map and clears them; Mica follows the switch', () => {
    const s = emptyState();
    call(s, 'stash_draft', { taskId: 'x', description: { type: 'doc' } });
    expect(s.drafts.x).toEqual({ type: 'doc' });
    call(s, 'clear_draft', { taskId: 'x' });
    expect(s.drafts).toEqual({});
    expect(call<Snapshot>(s, 'set_mica', { on: true }).prefs).toMatchObject({ mica: true, micaAvailable: false });
  });
});
