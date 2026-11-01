import { describe, expect, it } from 'vitest';

import { fullProject } from '../../mocks/factories';
import type { Snapshot } from '../../lib/types';
import { STEPS, answeredBy, resumeAt, ruleSentence, ruleTable, stepIndex, visibleSteps } from './setupSteps';

type Pick4 = Pick<Snapshot, 'settings' | 'rounding' | 'projects' | 'shifts' | 'sync'>;
const fresh = (): Pick4 => ({ settings: {}, rounding: [], projects: [], shifts: [], sync: { targets: [], detected: [], promptPending: false, pendingCopy: null } });

describe('the steps', () => {
  it('keep their order, because the saved step number is a position in this list', () => {
    expect(STEPS).toEqual(['welcome', 'connect', 'theme', 'zones', 'rules', 'project', 'shifts', 'sync', 'autostart', 'summary']);
  });

  it('on a first computer show every step but "connect"', () => {
    expect(visibleSteps(fresh(), { offerConnect: false, skipAnswered: true })).toEqual(STEPS.filter((s) => s !== 'connect'));
  });

  it('offer connecting first when another computer left data, and skip what that data answers', () => {
    const merged: Pick4 = {
      ...fresh(),
      settings: { myZone: 'Europe/Lisbon' },
      rounding: [{ id: 'r', projectId: null, effectiveFrom: '2026-01-01', incrementMinutes: 15, method: 'up', deleted: false, stamp: { at: '', by: '' } }],
      projects: [fullProject({ id: 'p' })],
      shifts: [],
      sync: { ...fresh().sync, targets: [{ provider: 'oneDrive', root: 'C:\\OneDrive', folder: '', status: { lastWrittenAt: null, lastReadAt: null, lastError: null, lastErrorAt: null, warnings: [], ignoredFiles: 0, devicesSeen: 1 } }] },
    };
    // Before connecting: the offer comes first.
    expect(visibleSteps(fresh(), { offerConnect: true, skipAnswered: true })[1]).toBe('connect');
    // After: zones, rules, project and sync are answered; the theme, shifts and Start with Windows are still asked.
    expect(visibleSteps(merged, { offerConnect: true, skipAnswered: true })).toEqual(['welcome', 'theme', 'shifts', 'autostart', 'summary']);
    expect(['theme', 'autostart'].some((s) => answeredBy(s as (typeof STEPS)[number], merged))).toBe(false);
  });

  it('a rerun from Settings shows everything, even what is answered', () => {
    const s: Pick4 = { ...fresh(), projects: [fullProject({ id: 'p' })], settings: { myZone: 'UTC' } };
    expect(visibleSteps(s, { offerConnect: false, skipAnswered: false })).toEqual(STEPS.filter((x) => x !== 'connect'));
  });

  it('resume at the saved step, or the nearest visible one after it', () => {
    const steps = visibleSteps(fresh(), { offerConnect: false, skipAnswered: true });
    expect(resumeAt(0, steps)).toBe('welcome');
    expect(resumeAt(stepIndex('rules'), steps)).toBe('rules');
    expect(resumeAt(stepIndex('connect'), steps)).toBe('theme');
    expect(resumeAt(99, steps)).toBe('summary');
    expect(resumeAt(-3, steps)).toBe('welcome');
  });
});

describe('the rounding table', () => {
  it('shows what Up does: a started block counts in full', () => {
    expect(ruleTable({ incrementMinutes: 15, method: 'up' })).toEqual([
      { worked: 1, billed: 15 },
      { worked: 7, billed: 15 },
      { worked: 15, billed: 15 },
      { worked: 16, billed: 30 },
      { worked: 35, billed: 45 },
    ]);
  });

  it('shows Nearest, Down and Off', () => {
    expect(ruleTable({ incrementMinutes: 15, method: 'nearest' }).map((r) => r.billed)).toEqual([0, 0, 15, 15, 30]);
    expect(ruleTable({ incrementMinutes: 15, method: 'down' }).map((r) => r.billed)).toEqual([0, 0, 15, 15, 30]);
    expect(ruleTable({ incrementMinutes: 0, method: 'up' }).every((r) => r.billed === r.worked)).toBe(true);
  });

  it('says it in a sentence', () => {
    expect(ruleSentence({ incrementMinutes: 0, method: 'up' })).toMatch(/exactly the time you worked/);
    expect(ruleSentence({ incrementMinutes: 15, method: 'up' })).toMatch(/blocks of 15 minutes.*started block counts in full/);
  });
});

describe('a rerun from Settings', () => {
  const empty = { settings: {}, rounding: [], projects: [], shifts: [], sync: { targets: [], detected: [], promptPending: false, pendingCopy: null } } as never;
  it('leaves out the steps that create records, and keeps every settings step', () => {
    const steps = visibleSteps(empty, { offerConnect: false, skipAnswered: false, omitData: true });
    expect(steps).not.toContain('project');
    expect(steps).not.toContain('shifts');
    expect(steps).toEqual(['welcome', 'theme', 'zones', 'rules', 'sync', 'autostart', 'summary']);
    expect(visibleSteps(empty, { offerConnect: false, skipAnswered: false })).toContain('project');
  });
});
