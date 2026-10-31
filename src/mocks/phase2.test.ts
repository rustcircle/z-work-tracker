import { describe, expect, it } from 'vitest';

import type { Snapshot, WithId } from '../lib/types';
import { demoP2State } from './demoSeed';
import { assignSubtaskIds } from '../lib/subtasks';
import { emptyState, handle, type MockState } from './ipcMock';

const call = <T,>(s: MockState, cmd: string, a: Record<string, unknown> = {}) => handle(s, cmd, a) as T;
const fails = (s: MockState, cmd: string, a: Record<string, unknown>) => {
  try {
    handle(s, cmd, a);
  } catch (e) {
    return e as { code: string; message: string };
  }
  throw new Error(`${cmd} did not fail`);
};
const snap = (s: MockState) => call<Snapshot>(s, 'get_snapshot');

/** A store with one project at 60 EUR/h, one task, and a 20 minute work segment on 1 Feb. */
function world() {
  const s = emptyState('2026-02-10T12:00:00Z');
  const { id: projectId } = call<WithId>(s, 'create_project', { input: { name: 'P', color: '#2563EB', billable: true, budgetHours: null, clientZone: null } });
  call(s, 'set_rate', { input: { projectId, rateCents: 6000, currency: 'EUR', effectiveFrom: '2026-01-01T00:00:00Z', confirmRetroactive: true } });
  call(s, 'set_rounding', { input: { projectId: null, effectiveFrom: '2000-01-01', incrementMinutes: 15, method: 'up', confirmRetroactive: true }, today: '2026-02-10' });
  const { id: taskId } = call<WithId>(s, 'create_task', { input: { name: 'T', projectId, description: null, tags: ['tag-admin'] } });
  s.segments.push({ id: 'seg-a', taskId, deviceId: 'x', start: '2026-02-01T09:00:00Z', end: '2026-02-01T09:20:00Z', provisionalEnd: null });
  s.segments[0]!.deviceId = '11111111-1111-4111-8111-111111111111';
  return { s, projectId, taskId };
}

describe('starter tags and the cold start', () => {
  it('seeds the four backend tags and requires a tag on a cold start', () => {
    const s = emptyState();
    expect(snap(s).tags.map((t) => t.id)).toEqual(['tag-concept', 'tag-revision', 'tag-client-call', 'tag-admin']);
    expect(snap(s).launch.coldRequired).toEqual(['name', 'project', 'description', 'tags']);
    s.tags.forEach((t) => (t.deleted = true));
    expect(snap(s).launch.coldRequired).toEqual(['name', 'project', 'description']);
  });
});

describe('billable pauses and summaries match the fixed backend rules', () => {
  const request = (projectId: string) => ({ projectId, from: '2026-02-01', to: '2026-02-28', zone: 'UTC' });

  it('bills a span marked twice only once', () => {
    const { s, projectId, taskId } = world();
    const mark = (note: string) => call(s, 'mark_billable_pause', { input: { taskId, start: '2026-02-01T10:00:00Z', end: '2026-02-01T11:00:00Z', note } });
    mark('one');
    mark('two');
    expect(call<{ pauseSecs: number }>(s, 'summary_preview', { request: request(projectId) }).pauseSecs).toBe(3600);
  });

  it('keeps both sides of a billed segment on a later summary', () => {
    const { s, projectId, taskId } = world();
    s.segments[0]!.start = '2026-02-01T10:30:00Z';
    s.segments[0]!.end = '2026-02-01T11:00:00Z';
    call(s, 'create_summary', { request: request(projectId) });
    call(s, 'mark_billable_pause', { input: { taskId, start: '2026-02-01T10:00:00Z', end: '2026-02-01T12:00:00Z', note: '' } });
    expect(call<{ pauseSecs: number }>(s, 'summary_preview', { request: request(projectId) }).pauseSecs).toBe(5400);
  });
});

describe('colours', () => {
  it('stores #rrggbb in lowercase and refuses anything else, for projects and tags', () => {
    const s = emptyState();
    const created = call<WithId>(s, 'save_tag', { input: { name: 'Mine', color: '#AABBCC' } });
    expect(snap(s).tags.find((t) => t.id === created.id)?.color).toBe('#aabbcc');
    expect(fails(s, 'save_tag', { input: { name: 'Bad', color: '#abc' } }).code).toBe('validation');
    expect(fails(s, 'create_project', { input: { name: 'Bad', color: 'red', billable: true, budgetHours: null, clientZone: null } }).message).toBe('a color must look like #1a2b3c');
  });
});

describe('pauses, thinking and the pending default', () => {
  it('a billable pause is Billable only and rounds once with the work', () => {
    const { s, taskId } = world();
    call(s, 'mark_billable_pause', { input: { taskId, start: '2026-02-01T09:20:00Z', end: '2026-02-01T09:35:00Z', note: 'call' } });
    const p = snap(s).projects[0]!;
    expect(p.figures).toMatchObject({ exactSecs: 0, pauseSecs: 0 }); // figures only for budgeted or fixed-fee projects
    const preview = call<{ exactSecs: number; pauseSecs: number; billableSecs: number; totals: Record<string, number> }>(s, 'summary_preview', { request: { projectId: p.id, from: '2026-02-01', to: '2026-02-01', zone: 'UTC' } });
    expect(preview).toMatchObject({ exactSecs: 1200, pauseSecs: 900, billableSecs: 2700, totals: { EUR: 4500 } });
    expect(snap(s).tasks[0]).toMatchObject({ pauseSecs: 900 });
  });

  it('a pending gap counts nowhere, a kept one counts as work, a thinking one counts in Exact', () => {
    const { s, taskId } = world();
    s.gaps.push({ id: 'g1', segmentId: 'seg-a', taskId, deviceId: 'x', start: '2026-02-01T09:05:00Z', end: '2026-02-01T09:15:00Z', kind: 'idle', decision: 'pending', decisionStamp: { at: '', by: '' } });
    const worked = () => snap(s).segments.filter((x) => (x.kind ?? 'work') === 'work').reduce((n, x) => n + (Date.parse(x.end ?? '') - Date.parse(x.start)) / 1000, 0);
    expect(worked()).toBe(600);
    expect(snap(s).tasks[0]).toMatchObject({ unconfirmedSecs: 600 });
    call(s, 'decide_gap', { id: 'g1', decision: 'keep' });
    expect(worked()).toBe(1200);
    expect(snap(s).tasks[0]).toMatchObject({ unconfirmedSecs: 0 });
    call(s, 'decide_gap', { id: 'g1', decision: 'thinking' });
    expect(snap(s).segments.map((x) => x.kind)).toEqual(['work', 'thinking', 'work']);
    expect(snap(s).tasks[0]).toMatchObject({ thinkingSecs: 600 });
    call(s, 'decide_gap', { id: 'g1', decision: 'drop' });
    expect(snap(s).segments.map((x) => x.kind)).toEqual(['work', 'work']);
  });
});

describe('manual entries and corrections', () => {
  it('warns about overlap with the overlap code, and adds it when allowed', () => {
    const { s, taskId } = world();
    const input = { taskId, start: '2026-02-01T09:10:00Z', end: '2026-02-01T09:40:00Z', reason: 'forgot' };
    expect(fails(s, 'add_manual_entry', { input })).toMatchObject({ code: 'overlap', message: 'this overlaps time already logged on: T' });
    call(s, 'add_manual_entry', { input: { ...input, allowOverlap: true } });
    expect(snap(s).rawSegments.filter((r) => r.manual)).toHaveLength(1);
    expect(fails(s, 'add_manual_entry', { input: { ...input, end: '2026-03-01T00:00:00Z', allowOverlap: true } }).message).toBe("the end can't be in the future");
  });

  it('a correction keeps the raw times, void and restore are undoable, and every change is audited', () => {
    const { s } = world();
    call(s, 'correct_segment', { input: { segmentId: 'seg-a', start: '2026-02-01T09:00:00Z', end: '2026-02-01T09:10:00Z', reason: 'stopped early' } });
    expect(snap(s).rawSegments[0]).toMatchObject({ rawEnd: '2026-02-01T09:20:00Z', end: '2026-02-01T09:10:00Z', corrected: true, reason: 'stopped early' });
    call(s, 'void_segment', { id: 'seg-a', reason: 'not work' });
    expect(snap(s).rawSegments[0]).toMatchObject({ voided: true });
    expect(snap(s).segments).toHaveLength(0);
    call(s, 'restore_segment', { id: 'seg-a', reason: 'it was' });
    expect(snap(s).rawSegments[0]).toMatchObject({ voided: false, corrected: false, end: '2026-02-01T09:20:00Z' });
    expect(call<{ action: string }[]>(s, 'get_audit', { entityId: 'seg-a' }).map((e) => e.action).sort()).toEqual(['correct', 'restore', 'void']);
  });
});

describe('billing summaries', () => {
  it('creates a numbered summary that marks time billed, blocks corrections, and a void returns the time', () => {
    const { s, projectId } = world();
    const request = { projectId, from: '2026-02-01', to: '2026-02-01', zone: 'UTC' };
    const { id } = call<WithId>(s, 'create_summary', { request });
    const b = snap(s).billing.summaries[0]!;
    expect(b).toMatchObject({ reference: 'A-001', totals: { EUR: 3000 }, segmentIds: ['seg-a'] });
    expect(snap(s).tasks[0]).toMatchObject({ billedSecs: 1200, unbilledSecs: 0 });
    expect(fails(s, 'create_summary', { request }).message).toBe('there is no unbilled time in that period');
    expect(fails(s, 'void_segment', { id: 'seg-a', reason: 'x' })).toMatchObject({ code: 'conflict', message: 'this time is on a billing summary; void that summary first' });
    call(s, 'void_summary', { id });
    expect(snap(s).tasks[0]).toMatchObject({ billedSecs: 0, unbilledSecs: 1200 });
    // The number is not reused, and a different prefix applies to the next summary only.
    call(s, 'set_device_prefix', { prefix: ' pc2 ' });
    call(s, 'create_summary', { request });
    expect(snap(s).billing.summaries.map((x) => x.reference)).toEqual(['A-001', 'PC2-001']);
    expect(fails(s, 'set_device_prefix', { prefix: 'toolong' }).message).toBe('a prefix is 1 to 4 letters or digits');
  });
});

describe('fixed fee, budget alerts and templates', () => {
  it('a fixed-fee project earns no hourly money, reports its effective rate and tells when a rate is needed', () => {
    const { s, projectId } = world();
    call(s, 'update_project', { id: projectId, input: { name: 'P', color: '#2563eb', billable: true, budgetHours: null, clientZone: null, billingType: 'fixedFee', fixedFeeCents: 6000, feeCurrency: 'EUR' } });
    const p = snap(s).projects[0]!;
    // 20 minutes round up to 30: 30 EUR of time against a 60 EUR fee.
    expect(p.figures.budget).toEqual({ basis: 'fee', percent: 50, level: 0, needsTargetRate: false });
    expect(p.figures.effectiveHourlyCents).toBe(12_000);
    const preview = call<{ totals: object }>(s, 'summary_preview', { request: { projectId, from: '2026-02-01', to: '2026-02-01', zone: 'UTC' } });
    expect(preview.totals).toEqual({});
    s.rates = [];
    expect(snap(s).projects[0]!.figures.budget).toEqual({ basis: 'fee', percent: 0, level: 0, needsTargetRate: true });
    expect(fails(s, 'update_project', { id: projectId, input: { name: 'P', color: '#2563eb', billable: true, budgetHours: null, clientZone: null, billingType: 'fixedFee', feeCurrency: 'EUR' } }).message).toBe('enter the fixed fee');
  });

  it('a template makes a new draft with the text and tags, subtasks unticked', () => {
    const { s, projectId } = world();
    const doc = { type: 'doc', content: [{ type: 'taskList', content: [{ type: 'taskItem', attrs: { checked: true, subtaskId: 'x' }, content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Sketch' }] }] }] }] };
    const { id } = call<WithId>(s, 'save_template', { input: { name: 'Job', projectId, description: doc, tags: ['tag-concept'] } });
    const made = call<WithId>(s, 'task_from_template', { id, projectId: null });
    const t = snap(s).tasks.find((x) => x.id === made.id)!;
    expect(t).toMatchObject({ name: 'Job', state: 'draft', tags: ['tag-concept'] });
    expect(t.subtasks.map((i) => [i.text, i.checked, i.id !== 'x'])).toEqual([['Sketch', false, true]]);
  });
});

describe('subtasks, backups and reminders', () => {
  it('switching the active subtask while running splits the segment at now', () => {
    const s = demoP2State();
    const before = snap(s).segments.filter((x) => x.taskId === 't-logo' && x.end === null);
    expect(before).toHaveLength(1);
    call(s, 'set_active_subtask', { taskId: 't-logo', subtaskId: 'st-final' });
    const after = snap(s).segments.filter((x) => x.taskId === 't-logo' && x.start >= '2026-03-12T14:00:00Z' && x.kind === 'work');
    expect(after.map((x) => [x.subtaskId, x.end === null])).toEqual([['st-sketches', false], ['st-sketches', false], ['st-final', true]]);
    expect(fails(s, 'set_active_subtask', { taskId: 't-logo', subtaskId: 'nope' }).code).toBe('not_found');
  });

  it('restoring a backup keeps a safety copy, pauses, goes cold and warns when sync is on', () => {
    const s = demoP2State();
    call(s, 'restore_backup', { name: 'z-work-data-2026-03-11.json' });
    const out = snap(s);
    expect(out.tasks.find((t) => t.id === 't-logo')?.state).toBe('paused');
    expect(out.launch.warm).toBe(false);
    expect(call<{ name: string; safety: boolean }[]>(s, 'list_backups')[0]).toMatchObject({ safety: true });
    expect(out.notices.map((n) => n.message).join(' ')).toContain('The data just before it is kept as pre-restore-');
    expect(fails(s, 'restore_backup', { name: 'nope.json' }).code).toBe('not_found');
    expect(fails(s, 'set_backup_keep', { keep: 0 }).code).toBe('validation');
  });

  it('a long run raises a reminder, and keeping it running quiets it for the time asked', () => {
    const s = demoP2State();
    expect(snap(s).reminder).toBeNull();
    call(s, 'set_setting', { key: 'longRunMinutes', value: 60 });
    expect(snap(s).reminder).toMatchObject({ kind: 'longRun', taskId: 't-logo' });
    call(s, 'snooze_reminder', { minutes: 60 });
    expect(snap(s).reminder).toBeNull();
    s.now += 61 * 60;
    expect(snap(s).reminder).not.toBeNull();
    expect(fails(s, 'set_setting', { key: 'idleMinutes', value: -1 }).code).toBe('validation');
  });
});

describe('restoring a backup follows restore_backup in service.rs', () => {
  const BACKUP = 'z-work-data-2026-03-11.json';
  const request = { projectId: 'p-pack', from: '2026-02-23', to: '2026-03-06', zone: 'Europe/Lisbon' };

  /** The p2 seed (its backup was taken with Logo concepts running), then changes made after the backup. */
  function changedAfterBackup(): MockState {
    const s = demoP2State();
    s.now += 3600;
    call(s, 'set_setting', { key: 'idleMinutes', value: 25 });
    call(s, 'create_summary', { request });
    call(s, 'set_device_prefix', { prefix: 'zz' });
    call(s, 'set_theme', { theme: 'dark' });
    call(s, 'set_backup_keep', { keep: 12 });
    return s;
  }

  it('rolls data and replicated settings back, and keeps the prefix, preferences, the audit log and sync folders', () => {
    const s = changedAfterBackup();
    s.targets = [{ provider: 'oneDrive', root: 'C:\\OD', folder: 'C:\\OD\\zWorkTracker', status: { lastWrittenAt: null, lastReadAt: null, lastError: null, lastErrorAt: null, warnings: [], ignoredFiles: 0, devicesSeen: 0 } }];
    const auditBefore = s.audit.map((e) => e.id);
    expect(snap(s).billing.summaries.map((b) => b.reference)).toEqual(['A-001', 'A-002', 'A-003']);
    call(s, 'restore_backup', { name: BACKUP });
    const out = snap(s);
    // Rolled back: the records and the replicated setting.
    expect(out.billing.summaries.map((b) => b.reference)).toEqual(['A-001', 'A-002']);
    expect(out.settings.idleMinutes).toBeUndefined();
    // Kept: the prefix, the preferences, the sync folders.
    expect(out.billing.prefix).toBe('ZZ');
    expect(out.prefs.theme).toBe('dark');
    expect(out.backupKeep).toBe(12);
    expect(out.sync.targets.map((t) => t.root)).toEqual(['C:\\OD']);
    // Kept, and grown: every earlier entry is still there, with one new entry for the restore.
    const log = call<{ id: string; entity: string; entityId: string; action: string; after: unknown }[]>(s, 'get_audit', {});
    for (const id of auditBefore) expect(log.map((e) => e.id)).toContain(id);
    expect(log.filter((e) => e.entity === 'summary' && e.action === 'create').map((e) => (e.after as { reference: string }).reference).sort()).toEqual(['A-001', 'A-002', 'A-003']);
    const restores = log.filter((e) => e.entity === 'backup');
    expect(restores).toHaveLength(1);
    expect(restores[0]).toMatchObject({ entityId: BACKUP, action: 'restore', after: { safetyCopy: 'pre-restore-2026-03-12T16-20-00.json' } });
    expect(log).toHaveLength(auditBefore.length + 1);
  });

  it('never issues a restored-away number again', () => {
    const s = changedAfterBackup();
    call(s, 'restore_backup', { name: BACKUP });
    call(s, 'set_device_prefix', { prefix: 'a' });
    // A-003 existed only after the backup was taken: it is gone, and its number is still spent.
    expect(snap(s).billing.summaries.map((b) => b.reference)).toEqual(['A-001', 'A-002']);
    call(s, 'create_summary', { request });
    expect(snap(s).billing.summaries.map((b) => b.reference)).toEqual(['A-001', 'A-002', 'A-004']);
    expect(s.referenceMarks).toEqual({ A: 4 });
  });

  it('closes the task the backup held running at the backup\'s heartbeat, never as a crash', () => {
    const s = changedAfterBackup();
    const logo = () => s.tasks.find((t) => t.id === 't-logo');
    expect(logo()?.state).toBe('running');
    call(s, 'restore_backup', { name: BACKUP });
    expect(logo()).toMatchObject({ state: 'paused', pauseReason: { kind: 'backupRestored' } });
    // The backup was taken at 15:20; the restore at 16:20. The segment ends where the backup stopped knowing.
    const seg = s.segments.find((x) => x.taskId === 't-logo' && x.start === '2026-03-12T14:00:00Z');
    expect(seg?.end).toBe('2026-03-12T15:20:00Z');
    const text = snap(s).notices.map((n) => n.message).join('\n');
    expect(text).toContain('Logo concepts was running when this backup was taken. It is paused at the last moment the backup knows about (2026-03-12T15:20:00Z).');
    expect(text).toContain('Restored z-work-data-2026-03-11.json. The data just before it is kept as pre-restore-2026-03-12T16-20-00.json.');
    expect(text).not.toContain('did not shut down cleanly');
    expect(snap(s).launch.warm).toBe(false);
  });

  it('lists backups newest first by the date in the name, so a new safety copy is first', () => {
    const s = demoP2State();
    s.backups = [
      { name: 'pre-restore-2026-03-05T10-00-00.json', bytes: 1, safety: true },
      { name: 'z-work-data-2026-03-11.json', bytes: 1, safety: false },
      { name: 'z-work-data-2026-03-12.json', bytes: 1, safety: false },
      { name: 'pre-restore-2026-03-11T08-00-00.json', bytes: 1, safety: true },
    ];
    // Both kinds sort together on the date in the name. On one day, a safety copy (it has a time) comes before the daily copy.
    expect(call<{ name: string }[]>(s, 'list_backups').map((b) => b.name)).toEqual([
      'z-work-data-2026-03-12.json',
      'pre-restore-2026-03-11T08-00-00.json',
      'z-work-data-2026-03-11.json',
      'pre-restore-2026-03-05T10-00-00.json',
    ]);
  });

  it('keeps only the newest five safety copies', () => {
    const s = demoP2State();
    for (let i = 0; i < 7; i += 1) {
      s.now += 60;
      call(s, 'restore_backup', { name: BACKUP });
    }
    const safety = call<{ name: string; safety: boolean }[]>(s, 'list_backups').filter((b) => b.safety);
    expect(safety).toHaveLength(5);
    expect(safety.map((b) => b.name)).not.toContain('pre-restore-2026-03-05T10-00-00.json');
    expect(Object.keys(s.backupData).filter((n) => n.startsWith('pre-restore-'))).toHaveLength(5);
  });
});

const item = (text: string, subtaskId?: string) => ({ type: 'taskItem', attrs: { checked: false, ...(subtaskId ? { subtaskId } : {}) }, content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] });
const list = (...items: ReturnType<typeof item>[]) => ({ type: 'doc', content: [{ type: 'taskList', content: items }] });

describe('the mock keeps to the backend where the gate found drift', () => {
  it('the copy source is the task last started or resumed, not the last paused or stopped', () => {
    const { s, projectId } = world();
    s.warm = true;
    const make = (name: string) => call<WithId>(s, 'create_task', { input: { name, projectId, description: null, tags: ['tag-admin'] } }).id;
    const a = make('A');
    const b = make('B');
    call(s, 'start_task', { id: a });
    call(s, 'start_task', { id: b });
    // A was auto-paused by B. Stopping A is not working on A.
    call(s, 'stop_task', { id: a });
    expect(snap(s).launch.copySource?.taskId).toBe(b);
    call(s, 'pause_task', { id: b });
    expect(snap(s).launch.copySource?.taskId).toBe(b);
    call(s, 'resume_task', { id: b });
    expect(snap(s).launch.copySource?.taskId).toBe(b);
  });

  it('any move settles the owed copy, not only a move into the same folder', async () => {
    const s = emptyState();
    s.pendingCopy = { from: 'C:\Old', to: 'C:\Lost' };
    await handle(s, 'move_sync_target', { from: null, to: 'D:\Elsewhere', provider: 'googleDrive', replacing: false });
    expect(s.pendingCopy).toBeNull();
    s.folders['C:\Old'] = { devices: ['Office PC'], counts: { projects: 1, tasks: 1, segments: 1 }, available: false };
    await handle(s, 'move_sync_target', { from: 'C:\Old', to: 'D:\Elsewhere', provider: 'googleDrive', replacing: false });
    expect(s.pendingCopy).toEqual({ from: 'C:\Old', to: 'D:\Elsewhere' });
  });

  it('removing the active subtask\'s item clears it, by update and by patch', () => {
    const { s, projectId, taskId } = world();
    const doc = list(item('One', 'st-1'), item('Two', 'st-2'));
    call(s, 'patch_task', { id: taskId, patch: { description: doc } });
    call(s, 'set_active_subtask', { taskId, subtaskId: 'st-2' });
    expect(snap(s).tasks[0]?.activeSubtask).toBe('st-2');
    call(s, 'patch_task', { id: taskId, patch: { description: list(item('One', 'st-1'), item('Two', 'st-2'), item('Three')) } });
    expect(snap(s).tasks[0]?.activeSubtask).toBe('st-2');
    call(s, 'patch_task', { id: taskId, patch: { description: list(item('One', 'st-1')) } });
    expect(snap(s).tasks[0]?.activeSubtask).toBeNull();
    call(s, 'patch_task', { id: taskId, patch: { description: list(item('One', 'st-1'), item('Two', 'st-2')) } });
    call(s, 'set_active_subtask', { taskId, subtaskId: 'st-1' });
    call(s, 'update_task', { id: taskId, input: { name: 'T', projectId, description: list(item('Other', 'st-9')), continuedFrom: null, tags: [] } });
    expect(snap(s).tasks[0]?.activeSubtask).toBeNull();
  });

  it('gives a repeated subtask id to the first item only', () => {
    let n = 0;
    const out = assignSubtaskIds(list(item('One', 'same'), item('Two', 'same'), item('Three', 'same')), undefined, () => `new-${(n += 1)}`);
    const ids = (out as { content: { content: { attrs: { subtaskId: string } }[] }[] }).content[0]!.content.map((i) => i.attrs.subtaskId);
    expect(ids).toEqual(['same', 'new-1', 'new-2']);
    const kept = assignSubtaskIds(list(item('One', 'a'), item('Two', 'b')), undefined, () => 'x');
    expect((kept as { content: { content: { attrs: { subtaskId: string } }[] }[] }).content[0]!.content.map((i) => i.attrs.subtaskId)).toEqual(['a', 'b']);
  });

  it('computes prefix clashes from the other devices, with the first free letter as the default', () => {
    const s = emptyState();
    expect(snap(s).billing).toMatchObject({ prefix: 'A', clashes: [] });
    s.otherPrefixes = { 'Office PC': 'A', Laptop: 'B' };
    // Nobody has chosen on this device yet, so it takes the first letter nobody else uses.
    expect(snap(s).billing).toMatchObject({ prefix: 'C', clashes: [] });
    call(s, 'set_device_prefix', { prefix: 'b' });
    expect(snap(s).billing).toMatchObject({ prefix: 'B', clashes: ['Laptop'] });
    expect(snap(s).warnings).toEqual(['Another device uses the same reference prefix: Laptop. Choose a different prefix, or references can repeat.']);
    call(s, 'set_device_prefix', { prefix: 'ofc' });
    expect(snap(s).billing.clashes).toEqual([]);
    expect(snap(s).warnings).toEqual([]);
  });

  it('a summary fixes the default prefix, and numbers count under it', () => {
    const { s, projectId } = world();
    s.otherPrefixes = { 'Office PC': 'A' };
    call(s, 'create_summary', { request: { projectId, from: '2026-02-01', to: '2026-02-01', zone: 'UTC' } });
    expect(snap(s).billing.summaries.map((b) => b.reference)).toEqual(['B-001']);
    // Another device taking B later does not move this device's prefix.
    s.otherPrefixes = { 'Office PC': 'B' };
    expect(snap(s).billing.prefix).toBe('B');
    expect(snap(s).billing.clashes).toEqual(['Office PC']);
  });

  it('warns, in the backend\'s words, when two live summaries share a reference', () => {
    const { s, projectId } = world();
    call(s, 'create_summary', { request: { projectId, from: '2026-02-01', to: '2026-02-01', zone: 'UTC' } });
    const first = s.summaries[0]!;
    s.summaries.push({ ...first, id: 'other-device', deviceId: 'dev-2' });
    expect(snap(s).warnings).toEqual(["More than one billing summary uses the same reference: A-001. Change a device's prefix and void and reissue one of them."]);
    first.voided = true;
    expect(snap(s).warnings).toEqual([]);
  });

  it('refuses names the backend refuses', () => {
    const { s, projectId, taskId } = world();
    expect(fails(s, 'create_task', { input: { name: 'x'.repeat(201), projectId, description: null, tags: ['tag-admin'] } }).message).toBe('Task name is longer than 200 characters');
    expect(fails(s, 'patch_task', { id: taskId, patch: { name: 'x'.repeat(201) } }).message).toBe('Task name is longer than 200 characters');
    expect(fails(s, 'create_project', { input: { name: 'p'.repeat(81), color: '#2563eb', billable: true, budgetHours: null, clientZone: null } }).message).toBe('Project name is longer than 80 characters');
    expect(fails(s, 'create_task', { input: { name: '  ', projectId, description: null, tags: [] } }).message).toBe('Task name is required');
  });

  it('a segment of zero seconds still makes a row and can be billed, like the backend', () => {
    const { s, projectId, taskId } = world();
    s.segments.push({ id: 'seg-zero', taskId, deviceId: '11111111-1111-4111-8111-111111111111', start: '2026-02-02T09:00:00Z', end: '2026-02-02T09:00:00Z', provisionalEnd: null });
    const request = { projectId, from: '2026-02-02', to: '2026-02-02', zone: 'UTC' };
    expect(call<{ rows: { day: string; exactSecs: number }[] }>(s, 'summary_preview', { request }).rows).toMatchObject([{ day: '2026-02-02', exactSecs: 0 }]);
    call(s, 'create_summary', { request });
    expect(snap(s).billing.summaries[0]).toMatchObject({ reference: 'A-001', segmentIds: ['seg-zero'] });
  });

  it('voiding twice writes the history once', () => {
    const { s, projectId } = world();
    const { id } = call<WithId>(s, 'create_summary', { request: { projectId, from: '2026-02-01', to: '2026-02-01', zone: 'UTC' } });
    call(s, 'void_summary', { id });
    call(s, 'void_summary', { id });
    expect(call<{ action: string }[]>(s, 'get_audit', { entityId: id }).map((e) => e.action).sort()).toEqual(['create', 'void']);
  });

  it('writes the CSV as the backend does: no amounts under Hide earnings, and a Status row when voided', () => {
    const { s, projectId } = world();
    const { id } = call<WithId>(s, 'create_summary', { request: { projectId, from: '2026-02-01', to: '2026-02-01', zone: 'UTC' } });
    call(s, 'export_summary_csv', { id });
    expect(s.summaryCsvFiles[id]).toContain('Day,Task,Exact hours,Billable pause hours,Billable hours,EUR\r\n');
    expect(s.summaryCsvFiles[id]).toContain('Total,,0.33,0.00,0.50,30.00');
    expect(s.summaryCsvFiles[id]).not.toContain('Status');
    call(s, 'set_hide_earnings', { hide: true });
    call(s, 'void_summary', { id });
    call(s, 'export_summary_csv', { id });
    const hidden = s.summaryCsvFiles[id] ?? '';
    expect(hidden).toContain('Amounts are left out because Hide earnings is on.');
    expect(hidden).toContain('Status,Voided');
    expect(hidden).not.toContain('EUR');
    expect(hidden).not.toContain('30.00');
    expect(hidden).toContain('Total,,0.33,0.00,0.50\r\n');
  });
});
