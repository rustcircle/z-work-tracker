// The same fixtures run in Rust (z-work-core billing tests), so both sides stay in agreement.
import { describe, expect, it } from 'vitest';

import billing from '../../fixtures/billing-fixtures.json';
import tz from '../../fixtures/tz-fixtures.json';
import shellSource from '../../src-tauri/src/lib.rs?raw';
import { demoState } from '../mocks/demoSeed';
import { READ_ONLY_BLOCKED, emptyState, handle, readOnlyMessage, seedLease } from '../mocks/ipcMock';
import apiSource from './api.ts?raw';
import { RateBook, centsFromNumerator, exactNumeratorsOf, numeratorsOf, taskDays, totalCents } from './billing';
import { errorCode } from './errorMessage';
import type { RateVersion, RoundMethod, RoundingVersion } from './types';
import { addDays, clockAt, dayBounds, dayOf, offsetAt, parseIso, startOfDay, toIso } from './tz';

const stamp = { at: '2026-01-01T00:00:00Z', by: 'x' };

describe('shared tz fixtures', () => {
  it.each(tz.conversions)('$zone at $at', (c) => {
    const t = parseIso(c.at);
    expect(dayOf(t, c.zone)).toBe(c.day);
    expect(clockAt(t, c.zone)).toBe(c.clock);
    expect(offsetAt(t, c.zone) / 60).toBe(c.offsetMin);
  });

  it.each(tz.days)('$zone day $day', (c) => {
    expect(toIso(startOfDay(c.day, c.zone))).toBe(c.start);
    expect(dayBounds(c.day, c.zone).length).toBe(c.hours * 3600);
  });

  it.each(tz.splits)('split $zone $start', (c) => {
    const rows = taskDays(
      [{ taskId: 't', projectId: 'p', start: parseIso(c.start), end: parseIso(c.end) }],
      c.zone,
      new RateBook([], []),
      [{ id: 'r', projectId: null, effectiveFrom: '2000-01-01', incrementMinutes: 0, method: 'up', deleted: false, stamp }],
    ).sort((a, b) => a.day.localeCompare(b.day));
    expect(rows.map((r) => ({ day: r.day, secs: r.exactSecs }))).toEqual(c.pieces);
  });
});

describe('shared billing fixtures', () => {
  it.each(billing.cases)('$name', (c) => {
    const rates: RateVersion[] = c.rates.map((r, i) => ({
      id: `r${i}`, projectId: 'p', effectiveFrom: r.from, rateCents: r.cents, currency: r.currency, deleted: false, stamp,
    }));
    const rounding: RoundingVersion[] = c.rounding.map((r, i) => ({
      id: `o${i}`, projectId: null, effectiveFrom: r.from, incrementMinutes: r.minutes, method: r.method as RoundMethod, deleted: false, stamp,
    }));
    // Additive fields: pauses and thinking are lists of [from, to], fixedFee marks the project, rows[].pause is the pause seconds.
    const extra = c as typeof c & { pauses?: string[][]; thinking?: string[][]; fixedFee?: boolean; totals?: Record<string, number> };
    const span = (pair: string[], kind?: 'billablePause' | 'thinking') => ({ taskId: 't', projectId: 'p', start: parseIso(pair[0] as string), end: parseIso(pair[1] as string), ...(kind ? { kind } : {}) });
    const spans = [...c.segments.map((x) => span(x)), ...(extra.thinking ?? []).map((x) => span(x, 'thinking')), ...(extra.pauses ?? []).map((x) => span(x, 'billablePause'))];
    const book = new RateBook([{ id: 'p', billable: true, billingType: extra.fixedFee ? 'fixedFee' : 'hourly' }], rates);
    const rows = taskDays(spans, c.zone, book, rounding).sort((a, b) => a.day.localeCompare(b.day));
    expect(rows.length).toBe(c.rows.length);
    rows.forEach((r, i) => {
      const w = c.rows[i] as (typeof c.rows)[number] & { roundedToZero?: boolean; pause?: number };
      expect(r.day).toBe(w.day);
      expect(r.exactSecs).toBe(w.exact);
      expect(r.pauseSecs).toBe(w.pause ?? 0);
      expect(r.billableSecs).toBe(w.billable);
      expect(r.roundedToZero).toBe(w.roundedToZero ?? false);
      const amounts = Object.fromEntries(Object.entries(numeratorsOf([r])).map(([k, n]) => [k, centsFromNumerator(n)]));
      expect(amounts).toEqual(w.amounts);
      const exact = Object.fromEntries(Object.entries(exactNumeratorsOf([r])).map(([k, n]) => [k, centsFromNumerator(n)]));
      expect(exact).toEqual(w.exactAmounts);
    });
    if (extra.totals) expect(totalCents(rows)).toEqual(extra.totals);
  });

  it('addDays crosses months', () => {
    expect(addDays('2026-02-28', 1)).toBe('2026-03-01');
  });
});

// ---- Read-only: the commands the backend refuses while another computer holds the lease.

/**
 * Every command, by whether a computer that is read-only may run it. `blocked` changes data shared between computers, or restores
 * it, and the backend refuses it with the `read_only` code. Everything else only reads, or changes this computer's own preferences,
 * folders, files or drafts. A command with no entry here fails the first test below, so adding one means deciding which it is.
 */
const COMMANDS: Record<string, 'blocked' | 'allowed'> = {
  // Projects and tasks.
  create_project: 'blocked', update_project: 'blocked', set_project_archived: 'blocked', delete_project: 'blocked',
  create_task: 'blocked', update_task: 'blocked', patch_task: 'blocked', delete_draft: 'blocked', delete_task: 'blocked',
  task_from_template: 'blocked', set_active_subtask: 'blocked',
  // The timer.
  start_task: 'blocked', resume_task: 'blocked', pause_task: 'blocked', stop_task: 'blocked',
  // Logged time.
  add_manual_entry: 'blocked', correct_segment: 'blocked', void_segment: 'blocked', restore_segment: 'blocked', settle_lost_segment: 'blocked',
  decide_gap: 'blocked', mark_billable_pause: 'blocked', unmark_billable_pause: 'blocked',
  // Rules, settings and catalogues that sync.
  save_shift: 'blocked', delete_shift: 'blocked', revert_shift_version: 'blocked', set_rate: 'blocked', delete_rate_version: 'blocked',
  set_rounding: 'blocked', delete_rounding: 'blocked', set_setting: 'blocked', save_tag: 'blocked', delete_tag: 'blocked',
  save_template: 'blocked', delete_template: 'blocked',
  // Billing summaries and their prefix.
  create_summary: 'blocked', void_summary: 'blocked', set_device_prefix: 'blocked',
  // Putting older data back.
  restore_backup: 'blocked', restore_version: 'blocked', save_version_now: 'blocked',

  // Reading.
  get_snapshot: 'allowed', get_audit: 'allowed', summary_preview: 'allowed', list_backups: 'allowed', preview_sync_folder: 'allowed',
  preview_sync_move: 'allowed', list_versions: 'allowed', read_version_changes: 'allowed', preview_restore_version: 'allowed',
  lease_preview_take_over: 'allowed', pick_sync_folder: 'allowed',
  // Reports and files.
  export_xlsx: 'allowed', export_csv: 'allowed', export_summary_csv: 'allowed', export_pdf: 'allowed', pick_pdf_logo: 'allowed', clear_pdf_logo: 'allowed',
  // This computer only: preferences, setup, notices, drafts, reminders, Start with Windows, the window.
  set_theme: 'allowed', set_hide_earnings: 'allowed', set_backup_keep: 'allowed', mark_client_zone_prompt_done: 'allowed',
  mark_sync_prompt_done: 'allowed', set_setup_step: 'allowed', finish_setup: 'allowed', dismiss_notice: 'allowed', stash_draft: 'allowed',
  clear_draft: 'allowed', keep_unsaved_words: 'allowed', snooze_reminder: 'allowed', get_autostart: 'allowed', set_autostart: 'allowed',
  get_autostart_info: 'allowed', open_startup_settings: 'allowed', window_ready: 'allowed', ack_hide_notice: 'allowed', quit_app: 'allowed',
  // Sync folders and the lease itself: the way out of read-only has to work in read-only.
  add_sync_target: 'allowed', remove_sync_target: 'allowed', move_sync_target: 'allowed', sync_now: 'allowed', lease_take_over: 'allowed',
  lease_release: 'allowed', resolve_join: 'allowed',
  // Asking the computer that holds the lease to pause a task is what a read-only computer is for.
  request_remote_pause: 'allowed',
};

const blocked = Object.keys(COMMANDS).filter((c) => COMMANDS[c] === 'blocked');
const allowed = Object.keys(COMMANDS).filter((c) => COMMANDS[c] === 'allowed');

/** The commands the typed wrappers send. */
const apiCommands = (): string[] => [...apiSource.matchAll(/invoke(?:<[^()]*>)?\('([a-z_]+)'/g)].map((m) => m[1] ?? '');

/** Registered by the shell before the typed wrappers and the mock have them: subtask tags (1.4), until T1 adds both. */
const NOT_YET_IN_THE_UI: readonly string[] = ['set_subtask_tags'];

/** The commands the shell registers, from every `generate_handler![...]` list. */
function shellCommands(): string[] {
  const names = new Set<string>();
  for (const list of shellSource.matchAll(/generate_handler!\[([\s\S]*?)\]\s*\)/g)) {
    for (const entry of (list[1] ?? '').split(',')) {
      const path = entry.replace(/\/\/.*$/gm, '').replace(/#\[[^\]]*\]/g, '').trim();
      // The native smoke harness (`--features smoke`) has commands of its own, which the app never sends.
      if (path.startsWith('smoke::')) continue;
      // A path such as `commands::get_snapshot` registers `get_snapshot`.
      const name = (path.split('::').pop() ?? '').trim();
      if (/^[a-z_][a-z0-9_]*$/.test(name)) names.add(name);
    }
  }
  return [...names];
}

/** What a command did, as the error it threw (after a promise settles), or null. */
async function outcome(run: () => unknown): Promise<unknown> {
  try {
    await run();
    return null;
  } catch (e) {
    return e;
  }
}

/** Another computer (LAPTOP) holds the lease, so this one is read-only. */
function readOnlyWorld() {
  const s = demoState();
  seedLease(s, 'live');
  return s;
}

describe('the read-only gate', () => {
  it('has a place for every command the typed wrappers send, and for no other', () => {
    const sent = apiCommands();
    expect(sent.length).toBeGreaterThan(60);
    expect([...new Set(sent)].sort()).toEqual(Object.keys(COMMANDS).sort());
  });

  it('has a place for every command the shell registers', () => {
    const registered = shellCommands();
    expect(registered.length, 'no command list found in src-tauri/src/lib.rs').toBeGreaterThan(60);
    expect(registered.filter((c) => !(c in COMMANDS) && !NOT_YET_IN_THE_UI.includes(c))).toEqual([]);
  });

  it('is held by the mock as exactly the commands classified as blocked', () => {
    expect([...READ_ONLY_BLOCKED].sort()).toEqual([...blocked].sort());
  });

  it.each(blocked)('refuses %s with the backend\u2019s error while another computer holds the lease, and changes nothing', async (cmd) => {
    const s = readOnlyWorld();
    const before = JSON.stringify(s);
    expect(await outcome(() => handle(s, cmd, {}))).toEqual({ code: 'read_only', message: readOnlyMessage('LAPTOP') });
    expect(JSON.stringify(s)).toBe(before);
  });

  it.each(allowed)('lets %s through while read-only (it may fail for other reasons, never this one)', async (cmd) => {
    expect(errorCode(await outcome(() => handle(readOnlyWorld(), cmd, {})))).not.toBe('read_only');
  });

  it.each(Object.keys(COMMANDS))('has %s in the mock', async (cmd) => {
    // With no lease nothing is refused, so any failure here is from the empty arguments, and "unknown" would mean no handler.
    expect(errorCode(await outcome(() => handle(emptyState(), cmd, {})))).not.toBe('unknown');
  });

  it('refuses a synced setting but lets the two view settings through, because changing them is viewing', () => {
    const s = readOnlyWorld();
    for (const key of ['activeZone', 'showBoth']) expect(() => handle(s, 'set_setting', { key, value: key === 'showBoth' ? true : 'UTC' })).not.toThrow();
    for (const key of ['myZone', 'clientZone', 'idleMinutes', 'dailyTargetHours']) {
      expect(() => handle(s, 'set_setting', { key, value: null })).toThrow(expect.objectContaining({ code: 'read_only' }));
    }
  });

  it('refuses nothing when no folder is connected, which is how the mock starts', () => {
    const s = demoState();
    for (const cmd of blocked) expect(errorCode(outcomeSync(() => handle(s, cmd, {})))).not.toBe('read_only');
  });
});

/** The same, for a command that can't return a promise here. */
function outcomeSync(run: () => unknown): unknown {
  try {
    run();
    return null;
  } catch (e) {
    return e;
  }
}
