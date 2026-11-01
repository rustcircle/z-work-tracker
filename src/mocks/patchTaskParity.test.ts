// patch_task's compare-and-swap in the mock, against the same table the Rust core runs (machine.rs), so a test
// that passes on the mock says something about the real backend.
import { describe, expect, it } from 'vitest';

import type { PatchReply, RichDoc, WithId } from '../lib/types';
import parity from '../../fixtures/patch-task-parity.json';
import { emptyState, handle, type MockState } from './ipcMock';

type Fields = Partial<{ name: string; projectId: string; description: RichDoc; tags: string[] }>;
interface Case {
  name: string;
  patch: Fields;
  expected?: Fields;
  conflicts?: string[];
  error?: string;
  after: Fields;
}

/** A store holding the table's task, and the table with its stand-ins replaced by real project ids. */
function world(): { s: MockState; taskId: string; cases: Case[]; stored: Required<Fields> } {
  const s = emptyState('2026-02-10T12:00:00Z');
  const project = (name: string) => (handle(s, 'create_project', { input: { name, color: '#2563EB', billable: true, budgetHours: null, clientZone: null } }) as WithId).id;
  const ids: Record<string, string> = { A: project('A'), B: project('B'), C: project('C'), ARCHIVED: project('Archived') };
  const archived = s.projects.find((p) => p.id === ids.ARCHIVED);
  if (archived) archived.archived = true;
  const table = JSON.parse(JSON.stringify(parity).replace(/@(ARCHIVED|A|B|C)\b/g, (_, k: string) => ids[k] ?? k)) as { stored: Required<Fields>; cases: Case[] };
  const { id: taskId } = handle(s, 'create_task', { input: { name: table.stored.name, projectId: table.stored.projectId, description: table.stored.description, tags: table.stored.tags } }) as WithId;
  return { s, taskId, cases: table.cases, stored: table.stored };
}

describe('patch_task with expected values, the same table as the backend', () => {
  it.each(world().cases.map((c, i) => [c.name, i] as const))('%s', (_, i) => {
    const { s, taskId, cases } = world();
    const c = cases[i] as Case;
    const task = s.tasks.find((t) => t.id === taskId);
    if (!task) throw new Error('no task');
    const args = { id: taskId, patch: c.patch, ...(c.expected ? { expected: c.expected } : {}) };
    if (c.error) {
      expect(() => handle(s, 'patch_task', args)).toThrow();
      try {
        handle(s, 'patch_task', args);
      } catch (e) {
        expect((e as { code: string }).code).toBe(c.error);
      }
    } else {
      const reply = handle(s, 'patch_task', args) as PatchReply;
      expect(reply.conflicts).toEqual(c.conflicts ?? []);
      expect(reply.stored).toEqual({ name: task.name, projectId: task.projectId, description: task.description, tags: task.tags });
      expect(reply.snapshot.tasks.find((t) => t.id === taskId)?.name).toBe(task.name);
    }
    expect(task).toMatchObject(c.after);
  });

  it('only a write raises the revision, as in the backend', () => {
    const { s, taskId } = world();
    const first = handle(s, 'get_snapshot', {}) as { revision: number };
    expect((handle(s, 'get_snapshot', {}) as { revision: number }).revision).toBe(first.revision);
    const written = handle(s, 'patch_task', { id: taskId, patch: { name: 'Written' } }) as PatchReply;
    expect(written.snapshot.revision).toBeGreaterThan(first.revision);
    expect((handle(s, 'get_snapshot', {}) as { revision: number }).revision).toBe(written.snapshot.revision);
  });
});
