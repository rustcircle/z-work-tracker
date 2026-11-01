#!/usr/bin/env node
// Native smoke test on the host OS: real webview, real IPC, real Rust, real files.
// Part 1 uses a build with the test-only `smoke` feature, which adds a data-folder override and a few
// test commands. Part 2 launches the unmodified release binary with HOME pointed at a temporary folder.
// Not covered here: clicking the real tray icon, and anything on real Windows.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

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
const until = async (f, what) => { for (let i = 0; i < 80; i++) { const v = await f(); if (v) return v; await wait(100); } throw new Error('timed out: ' + what); };
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
const readStore = () => JSON.parse(readFileSync(join(dataDir, 'z-work-data.json'), 'utf8'));

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
  r.pdf = await inv('export_pdf', { request: { projectId: p.id, from: day(4), to: day(2), zone: 'UTC', title: 'Smoke', includePrices: true } });
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
  check('a PDF timesheet is written locally', pdf.subarray(0, 5).toString() === '%PDF-' && pdf.includes('Smoke'));
  check('tag colours are stored canonical and others refused', r1.tagColor === '#abcdef' && r1.badTag === 'validation', JSON.stringify([r1.tagColor, r1.badTag]));

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
  check('data and theme persist across relaunch', r2 && r2.tasks === 1 && r2.projects === 1 && r2.theme === 'solarizedDark', JSON.stringify(r2));
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
  check('one backup file exists', existsSync(join(dataDir, 'z-work-data.json.bak')));
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
  check('release build creates its store in the app data folder', existsSync(join(dir, 'z-work-data.json')));
  const device = JSON.parse(readFileSync(join(dir, 'z-work-data.json'), 'utf8')).deviceId;
  child.kill('SIGTERM');
  await withTimeout(exited, 8000);

  // Seed an open segment and a heartbeat: the release build must recover them on its own.
  const seeded = JSON.parse(readFileSync(join(dir, 'z-work-data.json'), 'utf8'));
  const stamp = { at: '2026-01-01T00:00:00Z', by: device };
  seeded.data.projects.p = { id: 'p', name: 'Seed', color: '#2563eb', createdAt: '2026-01-01T00:00:00Z', stamp };
  seeded.data.tasks.t = { id: 't', name: 'Seeded', projectId: 'p', description: null, createdAt: '2026-01-01T00:00:00Z', nameStamp: stamp, projectStamp: stamp, descriptionStamp: stamp, deletedStamp: stamp, state: 'running', stateStamp: stamp };
  seeded.data.segments.s = { id: 's', taskId: 't', deviceId: device, start: '2026-01-01T09:00:00Z', end: null };
  seeded.lastHeartbeat = '2026-01-01T09:30:00Z';
  writeFileSync(join(dir, 'z-work-data.json'), JSON.stringify(seeded));
  child = spawn(exe, [], { stdio: 'ignore', env: { ...process.env, HOME: home } });
  exited = new Promise((r) => child.on('exit', (code, signal) => r({ code, signal })));
  await sleep(5000);
  const after = JSON.parse(readFileSync(join(dir, 'z-work-data.json'), 'utf8'));
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
