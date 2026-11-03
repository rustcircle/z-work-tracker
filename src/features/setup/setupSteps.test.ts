import { describe, expect, it } from 'vitest';

import { fullProject } from '../../mocks/factories';
import type { Snapshot } from '../../lib/types';
import {
  FOLDER_OPTIONAL,
  FOLDER_URGED,
  NO_FOLDER,
  OPTIONAL_STEPS,
  SHARED_DATA_STEPS,
  STEPS,
  TWO_FOLDERS,
  answeredBy,
  folderLeftUnanswered,
  folderUrgedNow,
  followsHolder,
  isPermanentFolderUrged,
  resumeAt,
  ruleSentence,
  ruleTable,
  stepIndex,
  stepNote,
  visibleSteps,
  writesSharedData,
} from './setupSteps';

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

describe('the cloud folder in the Microsoft Store build (design test 70)', () => {
  it('is urged in the Store build, whose files Windows removes on uninstall, and not in the installer build', () => {
    expect(isPermanentFolderUrged(true)).toBe(true);
    expect(isPermanentFolderUrged(false)).toBe(false);
  });

  it('urges a folder only in the Store build and only while none is connected', () => {
    expect(folderUrgedNow({ packaged: true, folders: 0 })).toBe(true);
    expect(folderUrgedNow({ packaged: true, folders: 1 })).toBe(false);
    expect(folderUrgedNow({ packaged: true, folders: 2 })).toBe(false);
    expect(folderUrgedNow({ packaged: false, folders: 0 })).toBe(false);
    expect(folderUrgedNow({ packaged: false, folders: 1 })).toBe(false);
  });

  it('calls the folder step recommended while it is urged and optional otherwise, and leaves every other step as it was', () => {
    const urged = { packaged: true, folders: 0 };
    const elsewhere = { packaged: false, folders: 0 };
    expect(stepNote('sync', urged)).toBe('recommended');
    expect(stepNote('sync', elsewhere)).toBe('optional');
    expect(stepNote('sync', { packaged: true, folders: 1 })).toBe('optional');
    for (const id of STEPS.filter((x) => x !== 'sync')) {
      expect(stepNote(id, urged)).toBe(OPTIONAL_STEPS.includes(id) ? 'optional' : null);
      expect(stepNote(id, elsewhere)).toBe(stepNote(id, urged));
    }
    // The list itself is not touched: the folder step stays a step the user may leave out.
    expect(OPTIONAL_STEPS).toEqual(['project', 'shifts', 'sync']);
  });

  it('asks before setup leaves the folder step behind with no folder, in the Store build only', () => {
    const asks = (step: (typeof STEPS)[number], packaged: boolean, folders: number) => folderLeftUnanswered(step, { packaged, folders });
    // Skip on the folder step, and Finish with defaults from any step up to it.
    for (const id of STEPS.filter((x) => stepIndex(x) <= stepIndex('sync'))) expect(asks(id, true, 0)).toBe(true);
    // Once the folder step is behind, the person has answered it.
    for (const id of ['autostart', 'summary'] as const) expect(asks(id, true, 0)).toBe(false);
    // A connected folder is the answer, and the installer build never asks.
    expect(asks('sync', true, 1)).toBe(false);
    expect(asks('welcome', true, 2)).toBe(false);
    expect(asks('sync', false, 0)).toBe(false);
    expect(asks('welcome', false, 0)).toBe(false);
  });

  it('says what the design says, plainly', () => {
    expect(FOLDER_URGED.lead).toBe('Choose a cloud folder.');
    expect(FOLDER_URGED.body).toBe(
      'The Microsoft Store version keeps its files privately, and Windows removes them when the app is uninstalled. A OneDrive or Google Drive folder is what keeps your hours safe. Two folders are better: pick both if you use both.',
    );
    expect(NO_FOLDER).toEqual({
      title: 'Continue without a folder?',
      body: 'If you uninstall the app without one, your hours are gone. You can connect a folder later in Settings.',
      confirm: 'Continue without a folder',
    });
    expect(TWO_FOLDERS).toBe('Connecting both OneDrive and Google Drive keeps a working copy in each.');
    expect(FOLDER_OPTIONAL).toBe('Optional. To use zWorkTracker on two computers, it can write its data into a OneDrive or Google Drive folder. Nothing is switched on unless you tick a folder and connect it.');
    for (const text of [FOLDER_URGED.lead, FOLDER_URGED.body, NO_FOLDER.title, NO_FOLDER.body, NO_FOLDER.confirm, TWO_FOLDERS, FOLDER_OPTIONAL]) expect(text).not.toMatch(/[\u2013\u2014]/);
  });
});

describe('while another computer holds the lease (design test 70)', () => {
  it('the steps that write data shared between computers are zones, rules, the first project and shifts', () => {
    expect(SHARED_DATA_STEPS).toEqual(['zones', 'rules', 'project', 'shifts']);
    for (const id of STEPS) expect(writesSharedData(id)).toBe(SHARED_DATA_STEPS.includes(id));
    // This computer's own choices, and connecting folders, stay open to it.
    for (const id of ['theme', 'sync', 'connect', 'autostart'] as const) expect(writesSharedData(id)).toBe(false);
  });

  it('says whose they are and when they can be changed', () => {
    expect(followsHolder('LAPTOP')).toBe('These follow LAPTOP. You can change them after taking over.');
    expect(followsHolder('Another computer')).toBe('These follow Another computer. You can change them after taking over.');
  });
});
