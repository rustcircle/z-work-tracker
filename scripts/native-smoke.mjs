#!/usr/bin/env node
// Native smoke test on the host OS: real webview, real IPC, real Rust, real files.
// Part 1 uses a build with the test-only `smoke` feature, which adds a data-folder override and a few
// test commands. Part 2 launches the unmodified release binary with HOME pointed at a temporary folder.
// Not covered here: clicking the real tray icon, and anything on real Windows.
import { spawn, spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const work = mkdtempSync(join(tmpdir(), 'z-work-smoke-'));
const dataDir = join(work, 'data');
const syncRoot = join(work, 'sync');
const moveRoot = join(work, 'sync-moved');
mkdirSync(moveRoot, { recursive: true });
const exportDir = join(work, 'exports');
mkdirSync(syncRoot);
mkdirSync(exportDir);

function build(args) {
  const r = spawnSync('pnpm', ['tauri', 'build', ...args], { stdio: 'inherit', env: { ...process.env, LANG: 'en_US.UTF-8', LC_ALL: 'en_US.UTF-8' } });
  if (r.status !== 0) process.exit(r.status ?? 1);
}

const HELPERS = `
const inv = window.__TAURI_INTERNALS__.invoke;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
// By round trips to the backend, as a window nobody looks at can run a timer many seconds late. After about 7 seconds
// such a window's page stops altogether, so a run has to be done by then, or end up here with no report.
const until = async (f, what) => { const end = Date.now() + 20000; while (Date.now() < end) { const v = await f(); if (v) return v; await inv('get_snapshot').catch(() => undefined); } throw new Error('timed out: ' + what); };
const button = (text) => [...document.querySelectorAll('button')].find((b) => b.textContent.trim() === text && !b.disabled);
const report = (o) => inv('smoke_report', { text: JSON.stringify(o) });
const run = async (f) => { try { await report(await f()); } catch (e) { await report({ error: String(e && e.message || e) }); } };
`;

function launch(exe, script, out, env = {}) {
  const scriptPath = join(work, `script-${Date.now()}.js`);
  writeFileSync(scriptPath, HELPERS + script);
  const child = spawn(exe, [], {
    stdio: 'ignore',
    env: { ...process.env, ZWT_SMOKE_DATA_DIR: dataDir, ZWT_SMOKE_SCRIPT: scriptPath, ZWT_SMOKE_OUT: out, ZWT_SMOKE_EXPORT_DIR: exportDir, ...env },
  });
  const exited = new Promise((r) => child.on('exit', (code, signal) => r({ code, signal })));
  return { child, exited };
}

async function waitFile(path, ms = 40000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (existsSync(path)) {
      try {
        return JSON.parse(readFileSync(path, 'utf8'));
      } catch {
        /* still being written */
      }
    }
    await sleep(200);
  }
  return null;
}

const withTimeout = (p, ms) => Promise.race([p, sleep(ms).then(() => 'timeout')]);

// The store: one SQLite database (src-tauri/crates/z-work-core/src/store.rs). Each record is its JSON in `records`, the
// rest of the device's file is one JSON row, `meta.local`, and the heartbeat of a running timer is `meta.beat`.
const DB = 'z-work-data.db';
const KINDS = ['projects', 'tasks', 'segments', 'settings', 'shifts', 'rates', 'rounding', 'gaps', 'pauses', 'tags', 'templates', 'summaries', 'prefixes', 'auditLog', 'pauseRequests'];
const UPSERT_META = 'INSERT INTO meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value';
const sleepSync = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

// The store in `dir` as the 1.3.1 file looked: `meta.local` with `data` rebuilt from the records, every kind an object
// by id. Read from a copy of the database and its WAL: while the app runs it holds the file for itself alone (EXCLUSIVE
// locking), and a copy can't disturb it. Opening the copy replays its WAL. A copy is only kept when the database didn't
// change while it was taken, as a checkpoint in between would pair the file with a WAL that no longer belongs to it.
function readStoreAt(dir) {
  const path = join(dir, DB);
  if (!existsSync(path)) throw new Error(`no ${DB} in ${dir}`);
  for (let attempt = 1; ; attempt++) {
    const copy = mkdtempSync(join(work, 'db-copy-'));
    try {
      const before = statSync(path);
      for (const suffix of ['', '-wal']) {
        if (existsSync(path + suffix)) copyFileSync(path + suffix, join(copy, DB + suffix));
      }
      const after = statSync(path);
      if (before.mtimeMs !== after.mtimeMs || before.size !== after.size) throw new Error(`${DB} changed while it was copied`);
      const db = new DatabaseSync(join(copy, DB));
      try {
        const data = Object.fromEntries(KINDS.map((kind) => [kind, {}]));
        for (const { kind, id, json } of db.prepare('SELECT kind, id, json FROM records').all()) (data[kind] ??= {})[id] = JSON.parse(json);
        return { ...JSON.parse(db.prepare("SELECT value FROM meta WHERE key = 'local'").get().value), data };
      } finally {
        db.close();
      }
    } catch (e) {
      if (attempt === 5) throw e;
    } finally {
      rmSync(copy, { recursive: true, force: true });
    }
    sleepSync(200);
  }
}
const readStore = () => readStoreAt(dataDir);

// Changes the store in `dir` in one transaction, through `put(kind, record)`, `head(change)` on `meta.local` and
// `beat(at)`. Only while the app is closed: a running app holds the file, and the wait for it here would run out.
function changeStoreAt(dir, f) {
  const db = new DatabaseSync(join(dir, DB), { timeout: 5000 });
  const put = (kind, record) =>
    db.prepare('INSERT INTO records(kind, id, json) VALUES (?, ?, ?) ON CONFLICT(kind, id) DO UPDATE SET json = excluded.json').run(kind, record.id, JSON.stringify(record));
  const head = (change) => {
    const local = JSON.parse(db.prepare("SELECT value FROM meta WHERE key = 'local'").get().value);
    change(local);
    db.prepare(UPSERT_META).run('local', JSON.stringify(local));
  };
  const beat = (at) => db.prepare(UPSERT_META).run('beat', JSON.stringify(at));
  try {
    db.exec('BEGIN IMMEDIATE');
    f({ put, head, beat });
    db.exec('COMMIT');
  } catch (e) {
    if (db.isTransaction) db.exec('ROLLBACK');
    throw e;
  } finally {
    db.close();
  }
}

const LIST = { type: 'doc', content: [{ type: 'orderedList', attrs: { start: 1 }, content: ['First step', 'Second step'].map((text) => ({ type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] })) }] };

async function part1() {
  build(['--debug', '--no-bundle', '--features', 'smoke']);
  const exe = resolve('src-tauri/target/debug/zWorkTracker');

  // Run 1: first launch, real prompts, real commands, real DOM buttons, hide on close, tray toggle, quit.
  let out = join(work, 'r1.json');
  let app = launch(exe, `
run(async () => {
  const r = {};
  await until(() => document.querySelector('#root').children.length, 'render');
  r.bodyColor = getComputedStyle(document.body).backgroundColor;
  let s = await inv('get_snapshot');
  r.firstRunSyncPending = s.sync.promptPending;
  r.firstRunTargets = s.sync.targets.length;
  r.tzdb = s.tzdbVersion;
  r.setupPending = s.setup.pending;
  await until(() => document.querySelector('[data-testid="setup-wizard"]'), 'setup wizard');
  r.oldPromptAlso = /Not now/.test(document.body.innerText);
  document.querySelector('[data-testid="finish-defaults"]').click();
  await until(() => !document.querySelector('[data-testid="setup-wizard"]'), 'setup wizard to finish');
  await wait(400);
  s = await inv('get_snapshot');
  r.setupAfter = s.setup.pending;
  r.syncAfterSetup = [s.sync.promptPending, s.sync.targets.length];
  const p = await inv('create_project', { input: { name: 'Smoke project', color: '#dc2626', billable: true, budgetHours: null, clientZone: null } });
  await inv('set_rate', { input: { projectId: p.id, rateCents: 3600, currency: 'USD', effectiveFrom: new Date(Date.now() - 86400000).toISOString().slice(0, 19) + 'Z', confirmRetroactive: true } });
  await inv('set_rounding', { input: { projectId: null, effectiveFrom: '2000-01-01', incrementMinutes: 15, method: 'up', confirmRetroactive: true }, today: new Date().toISOString().slice(0, 10) });
  try { await inv('start_task', { id: 'nope' }); r.badStart = 'accepted'; } catch (e) { r.badStart = e.code; }
  try { await inv('create_task', { input: { name: '  ', projectId: p.id, description: null } }); r.blankName = 'accepted'; } catch (e) { r.blankName = e.code; }
  const blank = await inv('create_task', { input: { name: 'Blank', projectId: p.id, description: null } });
  try { await inv('start_task', { id: blank.id }); r.coldBlankStart = 'accepted'; } catch (e) { r.coldBlankStart = e.code; }
  await inv('delete_draft', { id: blank.id });
  const t = await inv('create_task', { input: { name: 'Smoke task', projectId: p.id, description: ${JSON.stringify(LIST)}, tags: ['tag-concept'] } });
  r.coldBefore = (await inv('get_snapshot')).launch.warm;
  await inv('set_theme', { theme: 'solarizedDark' });
  await inv('smoke_emit_changed');
  await until(() => document.documentElement.dataset.theme === 'solarizedDark', 'theme applied');
  r.themeBg = getComputedStyle(document.body).backgroundColor;
  await until(() => /Smoke task/.test(document.body.innerText), 'task shown');
  (await until(() => button('Start'), 'Start button')).click();
  await wait(1500);
  s = await inv('get_snapshot');
  r.afterStart = s.tasks[0].state;
  r.warmAfterStart = s.launch.warm;
  r.copySource = s.launch.copySource && s.launch.copySource.name;
  const segBefore = JSON.stringify(s.segments);
  await inv('update_task', { id: s.tasks[0].id, input: { name: 'Smoke task', projectId: p.id, description: null } });
  await inv('update_task', { id: s.tasks[0].id, input: { name: 'Smoke task', projectId: p.id, description: ${JSON.stringify(LIST)} } });
  try { await inv('update_task', { id: s.tasks[0].id, input: { name: '  ', projectId: p.id, description: null } }); r.blankEdit = 'accepted'; } catch (e) { r.blankEdit = e.code; }
  s = await inv('get_snapshot');
  r.editLeavesSegments = JSON.stringify(s.segments) === segBefore && s.tasks[0].state === 'running';
  (await until(() => button('Pause'), 'Pause button')).click();
  await wait(800);
  r.afterPause = (await inv('get_snapshot')).tasks[0].state;
  (await until(() => button('Resume'), 'Resume button')).click();
  await wait(1200);
  r.afterResume = (await inv('get_snapshot')).tasks[0].state;
  const request = { dayZone: 'America/New_York', myZone: 'Europe/Lisbon', clientZone: 'America/New_York', includeEarnings: true, segmentShifts: {}, analytics: [] };
  r.xlsx = await inv('export_xlsx', { request });
  r.csv = await inv('export_csv', { request });
  // Gap-fill round on the real backend.
  const nyDay = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(new Date());
  r.selCsv = await inv('export_csv', { request: { ...request, selection: [{ taskId: t.id, day: nyDay }] } });
  try { await inv('export_csv', { request: { ...request, selection: [] } }); r.emptySel = 'accepted'; } catch (e) { r.emptySel = e.code; }
  const twin = await inv('create_project', { input: { name: 'Same colour', color: '#DC2626', billable: true } });
  r.twin = [twin.replacedFrom, twin.color];
  await inv('stash_draft', { taskId: t.id, description: ${JSON.stringify(LIST)} });
  await inv('clear_draft', { taskId: t.id });
  try { await inv('request_remote_pause', { taskId: t.id }); r.pauseHere = 'accepted'; } catch (e) { r.pauseHere = e.code; }
  const micaSnap = await inv('set_mica', { on: false });
  r.mica = [micaSnap.prefs.mica, micaSnap.prefs.micaAvailable];
  // Phase 2 on the real backend: time away, corrections, billing, PDF, tags, backups.
  await inv('smoke_observe', { idle: 3600 });
  await wait(1100);
  await inv('smoke_observe', { idle: 0 });
  // A lock is noticed whatever the idle count says.
  await inv('smoke_observe', { idle: 0, locked: true, lockedAgo: 60 });
  await inv('smoke_observe', { idle: 0, locked: false });
  s = await inv('get_snapshot');
  r.lockGap = s.gaps.filter((g) => g.kind === 'lock' && g.decision === 'pending').length;
  for (const g of s.gaps.filter((x) => x.kind === 'lock')) s = await inv('decide_gap', { id: g.id, decision: 'drop' });
  s = await inv('get_snapshot');
  r.gapsFound = s.gaps.filter((g) => g.decision === 'pending').length;
  s = await inv('decide_gap', { id: s.gaps.find((g) => g.decision === 'pending')?.id ?? 'none', decision: 'keep' });
  r.gapsAfterKeep = s.gaps.filter((g) => g.decision === 'pending').length;
  r.copyTags = s.launch.copySource?.tags;
  const day = (n) => new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);
  const taskId = s.tasks[0].id;
  const manual = await inv('add_manual_entry', { input: { taskId, start: day(3) + 'T09:00:00Z', end: day(3) + 'T10:00:00Z', reason: 'smoke', allowOverlap: true } });
  r.manualRaw = manual.snapshot.rawSegments.filter((x) => x.manual).length;
  const manualSeg = manual.id;
  await inv('correct_segment', { input: { segmentId: manualSeg, start: day(3) + 'T09:00:00Z', end: day(3) + 'T09:30:00Z', reason: 'smoke fix', allowOverlap: true } });
  r.auditActions = (await inv('get_audit', { entityId: manualSeg })).map((a) => a.action);
  await inv('mark_billable_pause', { input: { taskId, start: day(3) + 'T11:00:00Z', end: day(3) + 'T11:30:00Z', note: 'call' } });
  const period = { projectId: p.id, from: day(4), to: day(2), zone: 'UTC' };
  const preview = await inv('summary_preview', { request: period });
  r.previewPause = preview.pauseSecs;
  r.previewExact = preview.exactSecs;
  const bill = await inv('create_summary', { request: period });
  r.reference = bill.snapshot.billing.summaries[0]?.reference;
  r.summaryCsv = await inv('export_summary_csv', { id: bill.id });
  r.pdfSaved = await inv('export_pdf', { request: { projectId: p.id, from: day(4), to: day(2), zone: 'UTC', title: 'Smoke Ωμέγα 日本', includePrices: true } });
  r.pdf = r.pdfSaved.path;
  try { await inv('delete_task', { id: taskId }); r.deleteRunning = 'accepted'; } catch (e) { r.deleteRunning = e.code; }
  const gone = await inv('create_task', { input: { name: 'Smoke gone', projectId: p.id, description: null, tags: [] } });
  await inv('add_manual_entry', { input: { taskId: gone.id, start: day(6) + 'T09:00:00Z', end: day(6) + 'T10:00:00Z', reason: 'smoke', allowOverlap: true } });
  s = await inv('delete_task', { id: gone.id });
  r.deletedShows = [s.tasks, s.rawSegments.map((x) => ({ id: x.taskId })), s.segments.map((x) => ({ id: x.taskId }))].map((l) => l.some((x) => x.id === gone.id));
  r.deleteAudit = (await inv('get_audit', { entityId: gone.id })).map((a) => a.action);
  const tag = await inv('save_tag', { input: { name: 'Painted', color: '#ABCDEF' } });
  r.tagColor = tag.snapshot.tags.find((x) => x.id === tag.id)?.color;
  try { await inv('save_tag', { input: { name: 'Bad', color: 'red' } }); r.badTag = 'accepted'; } catch (e) { r.badTag = e.code; }
  await inv('add_sync_target', { provider: 'custom', root: ${JSON.stringify(syncRoot)} });
  await inv('sync_now');
  s = await inv('get_snapshot');
  r.syncStatus = s.sync.targets[0].status;
  r.movePreview = await inv('preview_sync_move', { from: ${JSON.stringify(syncRoot)}, to: ${JSON.stringify(moveRoot)} });
  r.moveResult = await inv('move_sync_target', { from: ${JSON.stringify(syncRoot)}, to: ${JSON.stringify(moveRoot)}, provider: 'custom', replacing: true });
  r.movedTargets = (await inv('get_snapshot')).sync.targets.map((t) => t.root);
  r.visibleBefore = await inv('smoke_window_visible');
  await inv('smoke_close_window');
  await until(() => /tray/i.test(document.body.innerText) && button('OK'), 'first-hide notice');
  r.noticeText = [...document.querySelectorAll('dialog[open], [role=dialog]')].map((d) => d.innerText).join(' ').slice(0, 300);
  button('OK').click();
  await wait(1000);
  r.visibleAfterClose = await inv('smoke_window_visible');
  s = await inv('get_snapshot');
  r.runningWhileHidden = s.tasks[0].state;
  r.openWhileHidden = s.segments.filter((x) => x.end === null).length;
  await inv('smoke_close_window').catch(() => {});
  await inv('smoke_tray_toggle');
  await wait(400);
  r.afterTrayPause = (await inv('get_snapshot')).tasks[0].state;
  await inv('smoke_tray_toggle');
  await wait(400);
  r.afterTrayResume = (await inv('get_snapshot')).tasks[0].state;
  return r;
}).then(() => inv('quit_app'));
`, out);
  const r1 = await waitFile(out);
  check('first launch ran the scripted session', r1 && !r1.error, r1?.error ?? '');
  if (!r1 || r1.error) {
    // A running copy would make the next launch exit at once, as a second instance.
    app.child.kill();
    return false;
  }
  const exit1 = await withTimeout(app.exited, 15000);
  check('tray-style quit really exits', exit1 !== 'timeout' && exit1.code === 0, JSON.stringify(exit1));
  check('nothing syncs silently on first launch', r1.firstRunSyncPending === true && r1.firstRunTargets === 0);
  check('a fresh store shows the setup wizard and not the old prompt', r1.setupPending === true && r1.oldPromptAlso === false);
  check('finishing setup with defaults enables no sync and is not asked again', r1.setupAfter === false && r1.syncAfterSetup?.[0] === false && r1.syncAfterSetup?.[1] === 0, JSON.stringify(r1.syncAfterSetup));
  check('an exact colour clash is replaced and reported by the real backend', r1.twin?.[0] === '#DC2626' && /^#[0-9a-f]{6}$/i.test(r1.twin?.[1] ?? '') && r1.twin[1].toLowerCase() !== '#dc2626', JSON.stringify(r1.twin));
  check('a selected CSV says so, and an empty selection is refused', /selection/.test(readFileSync(r1.selCsv ?? '', 'utf8')) && r1.emptySel === 'validation', r1.emptySel);
  check('a task running here cannot be asked to pause from here', r1.pauseHere === 'conflict', r1.pauseHere);
  check('Mica is off and unavailable off Windows', r1.mica?.[0] === false && r1.mica?.[1] === false, JSON.stringify(r1.mica));
  check('backend rejects unknown task and blank name', r1.badStart === 'not_found' && r1.blankName === 'validation', `${r1.badStart} ${r1.blankName}`);
  check('cold launch: a blank description cannot start, and the launch stays cold', r1.coldBlankStart === 'validation' && r1.coldBefore === false, r1.coldBlankStart);
  check('first start turns the launch warm, with a copy source', r1.warmAfterStart === true && r1.copySource === 'Smoke task');
  check('editing a running task leaves segments and state alone; blank name refused', r1.editLeavesSegments === true && r1.blankEdit === 'validation', r1.blankEdit);
  check('CSS loaded under the real CSP in the real webview', r1.bodyColor && r1.bodyColor !== 'rgba(0, 0, 0, 0)', r1.bodyColor);
  check('theme change applies', r1.themeBg === 'rgb(0, 43, 54)', r1.themeBg);
  check('real DOM Start, Pause, Resume drive the real backend', r1.afterStart === 'running' && r1.afterPause === 'paused' && r1.afterResume === 'running');
  check('Excel and CSV exports written', existsSync(r1.xlsx ?? '') && existsSync(r1.csv ?? ''));
  const deviceFiles = readdirSync(join(syncRoot, 'zWorkTracker', 'devices'));
  check('sync wrote this device file', Boolean(r1.syncStatus?.lastWrittenAt) && !r1.syncStatus?.lastError && deviceFiles.length === 1, JSON.stringify({ status: r1.syncStatus, deviceFiles }));
  check('changing the sync folder copies, checks and switches, and leaves the old file', r1.movePreview?.sourceAvailable === true && r1.moveResult?.checksum?.length === 16 && r1.movedTargets?.length === 1 && r1.movedTargets[0] === moveRoot && existsSync(join(moveRoot, 'zWorkTracker', 'devices', deviceFiles[0])) && existsSync(join(syncRoot, 'zWorkTracker', 'devices', deviceFiles[0])), JSON.stringify(r1.moveResult));
  check('closing the window hides it after the one-time notice', r1.visibleBefore === true && r1.visibleAfterClose === false, r1.noticeText);
  check('a running task keeps running while hidden', r1.runningWhileHidden === 'running' && r1.openWhileHidden === 1);
  check('tray Pause/Resume action works (command path, not an icon click)', r1.afterTrayPause === 'paused' && r1.afterTrayResume === 'running');
  let store = readStore();
  const seg = Object.values(store.data.segments);
  check('real exit closes the open segment and marks the task paused', seg.every((s) => s.end) && Object.values(store.data.tasks).find((t) => t.name === 'Smoke task')?.pauseReason?.kind === 'appQuit');
  check('timestamps on disk are UTC with Z', seg.every((s) => /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/.test(s.start)));
  const py = spawnSync('unzip', ['-t', r1.xlsx], { encoding: 'utf8' });
  check('Excel file is a valid archive', py.status === 0);
  check('idle time on the real path becomes an unconfirmed gap, and keep clears it', r1.gapsFound >= 1 && r1.gapsAfterKeep === 0, JSON.stringify([r1.gapsFound, r1.gapsAfterKeep]));
  check('a lock on the real path opens an unconfirmed gap with the idle count at zero', r1.lockGap === 1, String(r1.lockGap));
  check('a warm copy carries the tags', r1.copyTags?.includes('tag-concept'), JSON.stringify(r1.copyTags));
  check('manual entry and correction keep an audit trail', r1.manualRaw === 1 && r1.auditActions?.length === 2, JSON.stringify(r1.auditActions));
  check('the billing summary preview separates exact and pause, and issues A-001', r1.previewExact === 1800 && r1.previewPause === 1800 && r1.reference === 'A-001', JSON.stringify([r1.previewExact, r1.previewPause, r1.reference]));
  const billCsv = existsSync(r1.summaryCsv ?? '') ? readFileSync(r1.summaryCsv, 'utf8') : '';
  check('the summary CSV says it is not a tax document', /not a tax document/i.test(billCsv));
  const pdf = existsSync(r1.pdf ?? '') ? readFileSync(r1.pdf) : Buffer.alloc(0);
  check('a PDF timesheet is written locally, with its font embedded and a map for copying', pdf.subarray(0, 5).toString() === '%PDF-' && pdf.includes('NotoSans-Regular') && pdf.includes('/ToUnicode'));
  check('the export names what the font lacks, and only that', JSON.stringify(r1.pdfSaved?.unprintable) === JSON.stringify(['日', '本']));
  check('tag colours are stored canonical and others refused', r1.tagColor === '#abcdef' && r1.badTag === 'validation', JSON.stringify([r1.tagColor, r1.badTag]));
  check('a running task is not deleted, and a deleted one goes with its time and is audited', r1.deleteRunning === 'conflict' && r1.deletedShows?.every((shows) => !shows) && r1.deleteAudit?.[0] === 'delete', JSON.stringify([r1.deleteRunning, r1.deletedShows, r1.deleteAudit]));

  // Run 2: relaunch. Data and theme persist; start a task and get killed, simulating a crash.
  out = join(work, 'r2.json');
  app = launch(exe, `
run(async () => {
  await until(() => /Smoke task/.test(document.body.innerText), 'task shown after relaunch');
  const s = await inv('get_snapshot');
  const old = s.tasks[0];
  const r = { tasks: s.tasks.length, projects: s.projects.length, theme: document.documentElement.dataset.theme, reason: old.pauseReason, notices: s.notices.length, segments: s.segments.length, warm: s.launch.warm };
  try { await inv('resume_task', { id: old.id }); r.coldResume = 'accepted'; } catch (e) { r.coldResume = e.code; }
  await inv('smoke_tray_toggle');
  await wait(600);
  const afterTray = await inv('get_snapshot');
  r.trayColdState = afterTray.tasks.find((x) => x.id === old.id).state;
  r.trayColdSegments = afterTray.segments.length;
  r.trayColdVisible = await inv('smoke_window_visible');
  r.trayColdForm = /continuing/i.test(document.body.innerText);
  const next = await inv('create_task', { input: { name: 'Smoke continued', projectId: old.projectId, description: ${JSON.stringify(LIST)}, continuedFrom: old.id, tags: ['tag-concept'] } });
  await inv('start_task', { id: next.id });
  const done = await inv('get_snapshot');
  r.nextLink = done.tasks.find((x) => x.id === next.id).continuedFrom === old.id;
  const stillOld = done.tasks.find((x) => x.id === old.id);
  r.oldUnchanged = stillOld.state === 'paused' && stillOld.name === old.name && JSON.stringify(stillOld.description) === JSON.stringify(old.description);
  return r;
});
`, out);
  const r2 = await waitFile(out);
  check('data and theme persist across relaunch', r2 && r2.tasks === 1 && r2.projects === 2 && r2.theme === 'solarizedDark', JSON.stringify(r2));
  check('no crash notice after a clean exit', r2?.notices === 0);
  check('a relaunch is cold and the backend refuses resume', r2?.warm === false && r2?.coldResume === 'cold_start_required', r2?.coldResume);
  check('tray Resume while cold opens the form and starts nothing', r2?.trayColdState === 'paused' && r2?.trayColdSegments === r2?.segments && r2?.trayColdVisible === true && r2?.trayColdForm === true, JSON.stringify(r2));
  check('a cold continuation is a new linked task and the old stays as it was', r2?.nextLink === true && r2?.oldUnchanged === true);
  await sleep(1500);

  // A second launch must not start a second app.
  const second = spawn(exe, [], { stdio: 'ignore', env: { ...process.env, ZWT_SMOKE_DATA_DIR: dataDir } });
  const secondExit = await withTimeout(new Promise((r) => second.on('exit', (code) => r({ code }))), 10000);
  check('single instance: a second launch exits and the first stays', secondExit !== 'timeout' && app.child.exitCode === null, JSON.stringify(secondExit));

  store = readStore();
  check('segment is open on disk before the crash', Object.values(store.data.segments).some((s) => !s.end));
  app.child.kill('SIGKILL');
  await app.exited;
  await sleep(1500);

  // Run 3: crash recovery at launch; then `--quit` from a second process ends it cleanly.
  out = join(work, 'r3.json');
  app = launch(exe, `
run(async () => {
  await until(() => /Smoke task/.test(document.body.innerText), 'task');
  const s = await inv('get_snapshot');
  await until(() => /did not shut down cleanly/.test(document.body.innerText), 'crash notice on screen');
  const crashed = s.tasks.find((x) => x.name === 'Smoke continued');
  const r = { state: crashed.state, reason: crashed.pauseReason, notice: s.notices[0]?.message, open: s.segments.filter((x) => x.end === null).length };
  try { await inv('resume_task', { id: crashed.id }); r.coldResume = 'accepted'; } catch (e) { r.coldResume = e.code; }
  await until(async () => (await inv('list_backups')).length > 0, 'a dated backup exists');
  r.tasksBefore = s.tasks.length;
  const dated = (await inv('list_backups')).find((b) => !b.safety);
  r.datedBackup = dated?.name;
  const emptied = await inv('restore_backup', { name: dated.name });
  r.tasksAfterRestore = emptied.tasks.length;
  const safety = (await inv('list_backups')).find((b) => b.safety);
  r.safetyCopy = safety?.name;
  const back = await inv('restore_backup', { name: safety.name });
  r.tasksAfterUndo = back.tasks.length;
  const next = await inv('create_task', { input: { name: 'Smoke after crash', projectId: crashed.projectId, description: ${JSON.stringify(LIST)}, continuedFrom: crashed.id, tags: ['tag-concept'] } });
  await inv('start_task', { id: next.id });
  return r;
});
`, out);
  const r3 = await waitFile(out);
  check('crash recovery closes at the heartbeat, pauses and shows a notice', r3?.state === 'paused' && r3?.reason?.kind === 'crashRecovery' && r3?.open === 0 && /did not shut down/.test(r3?.notice ?? '') && /next start asks for every field/.test(r3?.notice ?? ''), JSON.stringify(r3));
  check('a dated backup exists and restoring it replaces the store', Boolean(r3?.datedBackup) && r3?.tasksAfterRestore < r3?.tasksBefore, JSON.stringify([r3?.datedBackup, r3?.tasksAfterRestore, r3?.tasksBefore]));
  check('restore keeps a safety copy that brings everything back', Boolean(r3?.safetyCopy) && r3?.tasksAfterUndo === r3?.tasksBefore, JSON.stringify([r3?.safetyCopy, r3?.tasksAfterUndo]));
  check('after a crash the launch is cold too', r3?.coldResume === 'cold_start_required', r3?.coldResume);
  await sleep(1000);
  const quitter = spawnSync(exe, ['--quit'], { env: { ...process.env, ZWT_SMOKE_DATA_DIR: dataDir }, timeout: 15000 });
  const exit3 = await withTimeout(app.exited, 15000);
  check('--quit (the installer path) exits the running app cleanly', quitter.status === 0 && exit3 !== 'timeout' && exit3.code === 0, JSON.stringify(exit3));
  store = readStore();
  check('--quit closed the running segment', Object.values(store.data.segments).every((s) => s.end) && Object.values(store.data.tasks).find((t) => t.name === 'Smoke after crash')?.pauseReason?.kind === 'appQuit');
  check('the store is the one database, with no JSON file, .bak or half-built database beside it', existsSync(join(dataDir, DB)) && !['z-work-data.json', 'z-work-data.json.bak', `${DB}.new`].some((f) => existsSync(join(dataDir, f))));

  // Run 4: words that met newer text, on the real backend. First a draft left over a description another device
  // has changed since, stamped older than the draft, which the launch must not put over it. The old rule would have.
  store = readStore();
  const heldTask = Object.values(store.data.tasks).find((t) => t.name === 'Smoke task');
  const para = (text) => ({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] });
  // Seconds before now, or after this device's own stamp on the description when that is later: saves in a burst stamp
  // ahead of the clock (the hybrid logical clock), and the order below must hold all the same.
  const since = Math.max(Date.now(), Date.parse(heldTask.descriptionStamp.at) + 3000);
  const iso = (ago) => new Date(since - ago * 1000).toISOString().slice(0, 19) + 'Z';
  heldTask.description = para('Text from another device');
  // Later than this device's own synced copy of the task, or the first sync would merge that back over it.
  heldTask.descriptionStamp = { at: iso(2), by: 'another-device' };
  changeStoreAt(dataDir, ({ put }) => put('tasks', heldTask));
  writeFileSync(join(dataDir, 'z-work-drafts.json'), JSON.stringify({ [heldTask.id]: { description: para('Words before the restart'), at: iso(1), base: LIST } }));
  out = join(work, 'r4.json');
  app = launch(exe, `
const para = (text) => ({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] });
const has = (doc, text) => JSON.stringify(doc).includes(text);
const form = () => document.querySelector('form.task-editor');
const kind = () => form()?.querySelector('[data-testid="save-state"]')?.dataset.kind;
const box = () => form().querySelector('[aria-multiline="true"]');
const stored = async (id) => (await inv('get_snapshot')).tasks.find((x) => x.id === id);
const type = (text) => { box().focus(); document.execCommand('insertText', false, text); };
const open = async (name) => { document.querySelector('button[aria-label="Edit ' + name + '"]').click(); await until(form, 'the editor'); };
run(async () => {
  await until(() => /Smoke task/.test(document.body.innerText), 'task');
  const r = {};
  let s = await inv('get_snapshot');
  const t = s.tasks.find((x) => x.name === 'Smoke task');
  const id = t.id;
  r.replayKept = has(t.description, 'Text from another device') && !has(t.description, 'Words before the restart');
  r.replayNotices = s.notices.map((n) => n.message);
  await until(() => /Words before the restart/.test(document.body.innerText), 'the words on screen in a notice');

  // The command: per field, what is stored comes back, and the rest of the patch goes.
  const stale = para('What an editor last showed');
  let a = await inv('patch_task', { id, patch: { name: 'Smoke renamed', description: para('Not sent') }, expected: { name: 'Smoke task', description: stale } });
  r.cmdConflicts = a.conflicts;
  r.cmdStoredText = has(a.stored.description, 'Text from another device');
  r.cmdStoredName = a.stored.name;
  r.cmdSnapshotName = a.snapshot.tasks.find((x) => x.id === id).name;
  a = await inv('patch_task', { id, patch: { description: a.stored.description }, expected: { description: stale } });
  r.cmdEqual = a.conflicts;
  a = await inv('patch_task', { id, patch: { name: 'Smoke task' } });
  r.cmdNoExpected = [a.conflicts, a.stored.name];
  r.revisionRises = a.snapshot.revision > s.revision;
  a = await inv('patch_task', { id, patch: { name: 'Nope' }, expected: { name: 'Older', description: stale } });
  r.cmdOtherFieldIgnored = a.conflicts;
  try { await inv('patch_task', { id, patch: { name: '  ' }, expected: { name: 'Smoke task' } }); r.cmdBlank = 'accepted'; } catch (e) { r.cmdBlank = e.code; }
  await inv('smoke_emit_changed');
  await wait(300);

  // The editor: words typed, newer text arrives, and the real autosave is refused.
  await open('Smoke task');
  type(' real words');
  await inv('patch_task', { id, patch: { description: para('Newer from elsewhere') } });
  await inv('smoke_emit_changed');
  await until(() => kind() === 'conflict', 'the hold');
  r.held = has((await stored(id)).description, 'Newer from elsewhere') && !has((await stored(id)).description, 'real words');
  r.heldNotice = form().querySelector('[data-testid="save-state"]').innerText;
  r.heldShown = box().innerText;
  type(' typed on');
  await wait(1500);
  r.typingKeepsHold = kind() === 'conflict' && has((await stored(id)).description, 'Newer from elsewhere');
  r.discardOffered = Boolean(button('Discard my words'));

  // Closed with the words held: a banner says so, and it outlives another action.
  document.querySelector('button[aria-label="Edit Smoke task"]').click();
  await until(() => !form(), 'the editor to close');
  await until(() => document.querySelector('[data-testid="held-banner"]'), 'the banner');
  await inv('set_mica', { on: false });
  await inv('smoke_emit_changed');
  await wait(300);
  r.bannerStays = Boolean(document.querySelector('[data-testid="held-banner"]'));
  await open('Smoke task');
  r.reopenedHeld = kind() === 'conflict' && !document.querySelector('[data-testid="held-banner"]');

  // Done after the notice has been up for a second is the choice, and sends no expected value.
  await wait(1200);
  button('Done').click();
  await until(() => !form(), 'Done to close');
  r.doneOverrides = has((await stored(id)).description, 'real words') && has((await stored(id)).description, 'typed on') && !has((await stored(id)).description, 'Newer from elsewhere');

  // A clean editor shows newer text, and a save goes from it.
  await open('Smoke task');
  await inv('patch_task', { id, patch: { description: para('Clean follows') } });
  await inv('smoke_emit_changed');
  await until(() => /Clean follows/.test(box().innerText), 'the newer text in a clean editor');
  type(' and on');
  await until(() => kind() === 'saved', 'the save');
  r.cleanFollows = has((await stored(id)).description, 'Clean follows') && has((await stored(id)).description, 'and on');

  // Discard keeps the newer text.
  type(' to give up');
  await inv('patch_task', { id, patch: { description: para('Keep me') } });
  await inv('smoke_emit_changed');
  await until(() => kind() === 'conflict', 'the second hold');
  button('Discard my words').click();
  await until(() => kind() === 'discarded', 'the discard');
  r.discarded = /Keep me/.test(box().innerText) && !/give up/.test(box().innerText) && has((await stored(id)).description, 'Keep me');
  // All that was typed and saved on this task, and the notice was never dismissed.
  r.noticeStays = /Words before the restart/.test(document.body.innerText);
  await wait(800);
  return r;
}).then(() => inv('quit_app'));
`, out);
  const r4 = await waitFile(out);
  check('words that met newer text ran on the real backend', r4 && !r4.error, r4?.error ?? '');
  if (!r4 || r4.error) {
    app.child.kill();
    return false;
  }
  const exit4 = await withTimeout(app.exited, 15000);
  check('and quit cleanly', exit4 !== 'timeout' && exit4.code === 0, JSON.stringify(exit4));
  check('a draft never replaces newer text at launch, and a notice shows the words', r4.replayKept === true && r4.replayNotices?.length === 1 && /Words before the restart/.test(r4.replayNotices[0]) && /its description changed while they waited/.test(r4.replayNotices[0]), JSON.stringify(r4.replayNotices));
  check('patch_task refuses only the stale field, gives back what is stored, and applies the rest', JSON.stringify(r4.cmdConflicts) === '["description"]' && r4.cmdStoredText === true && r4.cmdStoredName === 'Smoke renamed' && r4.cmdSnapshotName === 'Smoke renamed', JSON.stringify(r4.cmdConflicts));
  check('a stored value equal to the one saved is success, and no expected value changes nothing', JSON.stringify(r4.cmdEqual) === '[]' && JSON.stringify(r4.cmdNoExpected) === JSON.stringify([[], 'Smoke task']));
  check('an expected value for a field not sent is no concern, and a stale name alone conflicts', JSON.stringify(r4.cmdOtherFieldIgnored) === '["name"]', JSON.stringify(r4.cmdOtherFieldIgnored));
  check('a task can never become nameless through a patch', r4.cmdBlank === 'validation', r4.cmdBlank);
  check('snapshot revisions rise with changes', r4.revisionRises === true);
  check('the real autosave is refused: the newer text stays, the words stay shown, the notice is up', r4.held === true && /changed elsewhere/.test(r4.heldNotice) && /real words/.test(r4.heldShown), r4.heldNotice);
  check('typing on keeps the hold and the newer text', r4.typingKeepsHold === true && r4.discardOffered === true);
  check('a closed editor with held words leaves a banner that outlives other actions', r4.bannerStays === true && r4.reopenedHeld === true);
  check('Done after the notice saves the words over the newer text', r4.doneOverrides === true);
  check('a clean editor shows newer text and saves on from it', r4.cleanFollows === true);
  check('Discard my words keeps the newer text', r4.discarded === true);

  // Run 5: the notice was left up through all of that. It comes back, and only dismissing it ends the words.
  // Then an edit to a task deleted elsewhere, which no save can ever take.
  out = join(work, 'r5.json');
  app = launch(exe, `
const notice = () => document.querySelector('button[aria-label*="Words before the restart"]');
const form = () => document.querySelector('form.task-editor');
run(async () => {
  await until(notice, 'the notice to come back');
  let s = await inv('get_snapshot');
  const r = { notices: s.notices.map((n) => n.message) };
  notice().click();
  await until(() => !notice(), 'the notice to go');
  r.dismissed = true;
  const doomed = await inv('create_task', { input: { name: 'Smoke doomed', projectId: s.tasks.find((x) => x.name === 'Smoke task').projectId, description: null, tags: [] } });
  await inv('smoke_emit_changed');
  await until(() => document.querySelector('button[aria-label="Edit Smoke doomed"]'), 'the doomed task');
  document.querySelector('button[aria-label="Edit Smoke doomed"]').click();
  await until(form, 'its editor');
  form().querySelector('[aria-multiline="true"]').focus();
  document.execCommand('insertText', false, 'Words on a doomed task');
  await inv('delete_draft', { id: doomed.id });
  await inv('smoke_emit_changed');
  await until(() => document.querySelector('button[aria-label*="Words on a doomed task"]'), 'the notice with the words');
  r.goneClosed = !form();
  r.goneAlerts = [...document.querySelectorAll('[role="alert"]')].map((a) => a.textContent);
  s = await inv('get_snapshot');
  r.goneNotices = s.notices.map((n) => n.message);
  // A closed editor whose saves fail for real, as a folder stands in the way of the file a save writes first, until its
  // retries run out. They go at once here, as they would take a minute. A real write then has to send the words, by the
  // real revision.
  const stubborn = await inv('create_task', { input: { name: 'Smoke stubborn', projectId: s.tasks.find((x) => x.name === 'Smoke task').projectId, description: null, tags: [] } });
  await inv('smoke_emit_changed');
  await until(() => document.querySelector('button[aria-label="Edit Smoke stubborn"]'), 'the stubborn task');
  document.querySelector('button[aria-label="Edit Smoke stubborn"]').click();
  await until(form, 'its editor');
  const stubbornText = async () => JSON.stringify((await inv('get_snapshot')).tasks.find((x) => x.id === stubborn.id).description);
  const realTimeout = window.setTimeout;
  let lastRetryFired = false;
  window.setTimeout = (f, ms, ...rest) => {
    if (![2000, 4000, 8000, 16000, 32000].includes(ms)) return realTimeout(f, ms, ...rest);
    Promise.resolve().then(() => {
      f(...rest);
      if (ms === 32000) lastRetryFired = true;
    });
    return 0;
  };
  await inv('smoke_block_saves', { blocked: true });
  try {
    form().querySelector('[aria-multiline="true"]').focus();
    document.execCommand('insertText', false, 'Words that wait to save');
    // The editor hears of typing a moment later, and no hand is quicker than that to close it.
    await inv('get_snapshot');
    document.querySelector('button[aria-label="Edit Smoke stubborn"]').click();
    await until(() => lastRetryFired, 'the retries to run out');
    // The last of them has its save and its snapshot to wait for.
    for (let i = 0; i < 50; i++) await inv('get_snapshot');
    r.unsentBanner = document.querySelector('[data-testid="unsent-banner"]')?.textContent;
    r.unsentStored = (await stubbornText()).includes('Words that wait');
  } finally {
    window.setTimeout = realTimeout;
    await inv('smoke_block_saves', { blocked: false });
  }
  button('Hide earnings').click();
  await until(async () => (await stubbornText()).includes('Words that wait'), 'the later write to send the words');
  await until(() => !document.querySelector('[data-testid="unsent-banner"]'), 'the banner to go');
  r.sentByLaterWrite = true;
  return r;
}).then(() => inv('quit_app'));
`, out);
  const r5 = await waitFile(out);
  check('the words came back on the real backend', r5 && !r5.error, r5 ? (r5.error ?? '') : 'no report in time');
  if (!r5 || r5.error) {
    app.child.kill();
    return false;
  }
  const exit5 = await withTimeout(app.exited, 15000);
  check('and quit cleanly again', exit5 !== 'timeout' && exit5.code === 0, JSON.stringify(exit5));
  check('typing and saving on a task leaves the words its notice shows, and the notice comes back', r4.noticeStays === true && r5.notices?.some((m) => /Words before the restart/.test(m)), JSON.stringify(r5.notices));
  const keptNow = JSON.parse(readFileSync(join(dataDir, 'z-work-kept-words.json'), 'utf8'));
  check('dismissing the notice ends those words, and leaves no draft behind', r5.dismissed === true && !existsSync(join(dataDir, 'z-work-drafts.json')) && !JSON.stringify(keptNow).includes('Words before the restart'));
  check('an edit to a task deleted elsewhere goes in a notice with its words, and outlasts the run', r5.goneClosed === true && r5.goneAlerts?.length === 0 && r5.goneNotices?.length === 1 && /no longer exists/.test(r5.goneNotices[0]) && keptNow.length === 1 && keptNow[0].because === 'taskGone' && /Words on a doomed task/.test(keptNow[0].words), JSON.stringify([r5.goneAlerts, r5.goneNotices]));
  check('a closed editor whose saves fail for real says so in a banner, and when its retries have run out a later write sends the words', /could not be saved yet/.test(r5.unsentBanner ?? '') && r5.unsentStored === false && r5.sentByLaterWrite === true, JSON.stringify([r5.unsentBanner, r5.unsentStored, r5.sentByLaterWrite]));

  // Run 6: Shift+Enter and Enter in a description, on the real backend and in the real webview. The keys go to the
  // editor as keydown events, which its keymap hears as it does from the keyboard.
  out = join(work, 'r6.json');
  app = launch(exe, `
const form = () => document.querySelector('form.task-editor');
const box = () => form().querySelector('[aria-multiline="true"]');
const edit = (name) => document.querySelector('button[aria-label="Edit ' + name + '"]');
const stored = async (id) => (await inv('get_snapshot')).tasks.find((x) => x.id === id);
// A beat after each, as the editor reads what was typed from the page a moment later, which a person's pace allows for.
const type = async (text) => { box().focus(); document.execCommand('insertText', false, text); await wait(100); };
const enter = async (shiftKey) => { box().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, shiftKey, bubbles: true, cancelable: true })); await wait(100); };
// The paragraphs of the editor, a line break shown as a newline.
const blocks = () => [...box().children].filter((b) => b.tagName === 'P').map((p) => [...p.childNodes].map((n) => (n.nodeName === 'BR' ? (n.classList.contains('ProseMirror-trailingBreak') ? '' : '\\n') : n.textContent)).join(''));
// The same from a stored document.
const shape = (doc) => doc.content.filter((b) => b.type === 'paragraph' && b.content).map((p) => p.content.map((n) => (n.type === 'hardBreak' ? '\\n' : n.text)).join(''));
const breaks = (doc) => JSON.stringify(doc).match(/"type":"hardBreak"/g)?.length ?? 0;
const day = (n) => new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);
run(async () => {
  await until(() => /Smoke task/.test(document.body.innerText), 'task');
  const r = {};
  const projectId = (await inv('get_snapshot')).tasks.find((x) => x.name === 'Smoke task').projectId;

  // Typed in the editor, autosaved by the real backend, then the editor closed and opened again.
  const t = await inv('create_task', { input: { name: 'Smoke breaks', projectId, description: null, tags: [] } });
  await inv('smoke_emit_changed');
  await until(() => edit('Smoke breaks'), 'its card');
  edit('Smoke breaks').click();
  await until(form, 'its editor');
  await type('first line');
  await enter(true);
  await type('second line');
  await enter(false);
  await type('next paragraph');
  r.typed = blocks();
  await until(async () => JSON.stringify((await stored(t.id)).description).includes('next paragraph'), 'the autosave');
  r.storedShape = shape((await stored(t.id)).description);
  r.storedBreaks = breaks((await stored(t.id)).description);
  edit('Smoke breaks').click();
  await until(() => !form(), 'the editor to close');
  edit('Smoke breaks').click();
  await until(form, 'the editor again');
  r.reopened = blocks();

  // A task list typed the same way, with time on it: its subtasks are listed and it goes to Excel.
  const list = await inv('create_task', { input: { name: 'Smoke breaks list', projectId, description: null, tags: [] } });
  await inv('smoke_emit_changed');
  await until(() => edit('Smoke breaks list'), 'the list task');
  edit('Smoke breaks list').click();
  await until(() => form()?.getAttribute('aria-label') === 'Editing Smoke breaks list', 'its editor');
  form().querySelector('button[aria-label="Task list"]').click();
  await type('Call Anna');
  await enter(true);
  await type('about the invoice');
  await enter(false);
  await type('Send it');
  await until(async () => JSON.stringify((await stored(list.id)).description).includes('Send it'), 'the list to save');
  await inv('add_manual_entry', { input: { taskId: list.id, start: day(3) + 'T09:00:00Z', end: day(3) + 'T10:00:00Z', reason: 'smoke', allowOverlap: true } });
  r.xlsx = await inv('export_xlsx', { request: { dayZone: 'America/New_York', myZone: 'Europe/Lisbon', clientZone: 'America/New_York', includeEarnings: true, segmentShifts: {}, analytics: [] } });
  r.listSubtasks = (await stored(list.id)).subtasks.map((x) => x.text);
  // Two paragraphs in one item, which a paste makes, read as one line of words too.
  const para = (text) => ({ type: 'paragraph', content: [{ type: 'text', text }] });
  const pasted = await inv('create_task', { input: { name: 'Smoke two paragraphs', projectId, description: { type: 'doc', content: [{ type: 'taskList', content: [{ type: 'taskItem', attrs: { checked: false }, content: [para('Alpha'), para('Beta')] }] }] }, tags: [] } });
  r.twoParagraphs = (await stored(pasted.id)).subtasks.map((x) => x.text);

  // Words typed on a task that is deleted elsewhere go in a notice, a break as a space and a paragraph as a line.
  const doomed = await inv('create_task', { input: { name: 'Smoke breaks doomed', projectId, description: null, tags: [] } });
  await inv('smoke_emit_changed');
  await until(() => edit('Smoke breaks doomed'), 'the doomed task');
  edit('Smoke breaks doomed').click();
  await until(() => form()?.getAttribute('aria-label') === 'Editing Smoke breaks doomed', 'its editor');
  await type('Kept one');
  await enter(true);
  await type('kept two');
  await enter(false);
  await type('kept three');
  await inv('delete_draft', { id: doomed.id });
  await inv('smoke_emit_changed');
  await until(() => document.querySelector('button[aria-label*="Kept one"]'), 'the notice with the words');
  r.notice = (await inv('get_snapshot')).notices.map((n) => n.message).find((m) => /Kept one/.test(m));
  return r;
}).then(() => inv('quit_app'));
`, out);
  const r6 = await waitFile(out);
  check('line breaks and paragraphs ran on the real backend', r6 && !r6.error, r6 ? (r6.error ?? '') : 'no report in time');
  if (!r6 || r6.error) {
    app.child.kill();
    return false;
  }
  const exit6 = await withTimeout(app.exited, 15000);
  check('and quit cleanly a last time', exit6 !== 'timeout' && exit6.code === 0, JSON.stringify(exit6));
  const lines = ['first line\nsecond line', 'next paragraph'];
  check('in the real editor Shift+Enter is a line break inside the paragraph and Enter another paragraph, and the real backend stored both', JSON.stringify(r6.typed) === JSON.stringify(lines) && JSON.stringify(r6.storedShape) === JSON.stringify(lines) && r6.storedBreaks === 1, JSON.stringify([r6.typed, r6.storedShape, r6.storedBreaks]));
  check('closed and opened again the editor shows them as typed', JSON.stringify(r6.reopened) === JSON.stringify(lines), JSON.stringify(r6.reopened));
  const onDisk = Object.values(readStore().data.tasks).find((t) => t.name === 'Smoke breaks')?.description;
  const diskShape = (onDisk?.content ?? []).filter((b) => b.type === 'paragraph' && b.content).map((p) => p.content.map((n) => (n.type === 'hardBreak' ? '\n' : n.text)).join(''));
  check('and the file on disk holds the break and the paragraph', JSON.stringify(diskShape) === JSON.stringify(lines) && JSON.stringify(onDisk).includes('"type":"hardBreak"'), JSON.stringify(diskShape));
  const sheetStrings = existsSync(r6.xlsx ?? '') ? spawnSync('unzip', ['-p', r6.xlsx, 'xl/sharedStrings.xml'], { encoding: 'utf8' }).stdout : '';
  check('a break in a list item, or a second paragraph in one, is a space in the subtask list, and a break is a space in the Excel Subtasks column of a sound archive', sheetStrings.includes('[ ] Call Anna about the invoice\n[ ] Send it') && spawnSync('unzip', ['-t', r6.xlsx ?? ''], { encoding: 'utf8' }).status === 0 && JSON.stringify(r6.listSubtasks) === JSON.stringify(['Call Anna about the invoice', 'Send it']) && JSON.stringify(r6.twoParagraphs) === JSON.stringify(['Alpha Beta']), JSON.stringify([r6.listSubtasks, r6.twoParagraphs]));
  const wanted = 'Kept one kept two\nkept three';
  const keptWords = existsSync(join(dataDir, 'z-work-kept-words.json')) ? JSON.parse(readFileSync(join(dataDir, 'z-work-kept-words.json'), 'utf8')).map((k) => k.words) : [];
  check('words kept in a notice show a break as a space and a paragraph as a line, and so does their file', typeof r6.notice === 'string' && r6.notice.endsWith(wanted) && keptWords.includes(wanted), JSON.stringify([r6.notice, keptWords]));
  return true;
}

async function part2() {
  build(['--bundles', 'app']);
  const exe = resolve('src-tauri/target/release/bundle/macos/zWorkTracker.app/Contents/MacOS/zWorkTracker');
  const home = join(work, 'home');
  const dir = join(home, 'Library', 'Application Support', 'com.rustcircle.zworktracker');

  // Fresh start of the unmodified build: the store appears in the OS app data folder.
  let child = spawn(exe, [], { stdio: 'ignore', env: { ...process.env, HOME: home } });
  let exited = new Promise((r) => child.on('exit', (code, signal) => r({ code, signal })));
  await sleep(5000);
  check('release build starts and stays up', child.exitCode === null);
  check('release build creates its store in the app data folder', existsSync(join(dir, DB)));
  const device = readStoreAt(dir).deviceId;
  child.kill('SIGTERM');
  await withTimeout(exited, 8000);

  // Seed an open segment and a heartbeat: the release build must recover them on its own.
  const stamp = { at: '2026-01-01T00:00:00Z', by: device };
  const heartbeat = '2026-01-01T09:30:00Z';
  changeStoreAt(dir, ({ put, head, beat }) => {
    put('projects', { id: 'p', name: 'Seed', color: '#2563eb', createdAt: '2026-01-01T00:00:00Z', stamp });
    put('tasks', { id: 't', name: 'Seeded', projectId: 'p', description: null, createdAt: '2026-01-01T00:00:00Z', nameStamp: stamp, projectStamp: stamp, descriptionStamp: stamp, deletedStamp: stamp, state: 'running', stateStamp: stamp });
    put('segments', { id: 's', taskId: 't', deviceId: device, start: '2026-01-01T09:00:00Z', end: null });
    head((local) => {
      local.lastHeartbeat = heartbeat;
    });
    // As a run that crashed leaves it: the launch takes the later of the two.
    beat(heartbeat);
  });
  child = spawn(exe, [], { stdio: 'ignore', env: { ...process.env, HOME: home } });
  exited = new Promise((r) => child.on('exit', (code, signal) => r({ code, signal })));
  await sleep(5000);
  const after = readStoreAt(dir);
  check('release build recovers a crash at launch', after.data.segments.s.end === '2026-01-01T09:30:00Z' && after.data.tasks.t.state === 'paused');
  check('release build kept the seeded data across relaunch', after.data.projects.p?.name === 'Seed');
  const q = spawnSync(exe, ['--quit'], { env: { ...process.env, HOME: home }, timeout: 15000 });
  const e = await withTimeout(exited, 15000);
  check('release build exits on --quit', q.status === 0 && e !== 'timeout', JSON.stringify(e));
}

const ok = await part1();
if (ok) await part2();
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length} of ${results.length} native smoke checks passed on ${process.platform}.`);
rmSync(work, { recursive: true, force: true });
process.exit(failed.length || !ok ? 1 : 0);
