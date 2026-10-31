#!/usr/bin/env node
// Measures the real app on this Mac: cold start, then CPU, wakeups and memory while hidden in the tray
// with a task running. It uses a release build with the test-only `smoke` feature, for the data-folder
// override and the script hook, and a temporary store, so it never touches real data.
//
//   CARGO_TARGET_DIR=<dir> pnpm tauri build --no-bundle --features smoke
//   node scripts/perf-native.mjs --exe <dir>/release/zWorkTracker --out out.json [--store <bench store>]
//
// macOS only, and a macOS window that is covered can stop drawing. Windows has to be measured on Windows.
import { execFileSync, spawn } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
};
const EXE = arg('exe', 'src-tauri/target/release/zWorkTracker');
const STORE = arg('store', null);
const OUT = arg('out', null);
const WINDOW_S = Number(arg('seconds', 150));
const COLD_RUNS = Number(arg('cold', 7));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];

const HELPERS = `
const inv = window.__TAURI_INTERNALS__.invoke;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (f, what) => { for (let i = 0; i < 300; i++) { const v = await f(); if (v) return v; await wait(100); } throw new Error('timed out: ' + what); };
const report = (o) => inv('smoke_report', { text: JSON.stringify(o) });
const run = async (f) => { try { await report(await f()); } catch (e) { await report({ error: String(e && e.message || e) }); } };
`;

async function waitJson(path, ms = 90_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (existsSync(path)) {
      try {
        return JSON.parse(readFileSync(path, 'utf8'));
      } catch {
        /* still being written */
      }
    }
    await sleep(50);
  }
  return null;
}

function launch(work, script) {
  const data = join(work, 'data');
  const out = join(work, `out-${Date.now()}.json`);
  const scriptPath = join(work, `script-${Date.now()}.js`);
  writeFileSync(scriptPath, HELPERS + script);
  mkdirSync(join(work, 'home'), { recursive: true });
  const t0 = Date.now();
  const child = spawn(EXE, [], { stdio: 'ignore', env: { ...process.env, HOME: join(work, 'home'), ZWT_SMOKE_DATA_DIR: data, ZWT_SMOKE_SCRIPT: scriptPath, ZWT_SMOKE_OUT: out } });
  const exited = new Promise((r) => child.on('exit', r));
  return { child, exited, out, t0 };
}

async function quit(app) {
  app.child.kill('SIGTERM');
  await Promise.race([app.exited, sleep(10_000)]);
  if (app.child.exitCode === null && app.child.signalCode === null) app.child.kill('SIGKILL');
  await sleep(500);
}

/** The WebKit helpers run under launchd, so they are found by when they started. */
function helpers(t0) {
  const lines = execFileSync('ps', ['-axo', 'pid=,lstart=,comm='], { encoding: 'utf8', maxBuffer: 1 << 26 }).split('\n');
  const out = [];
  for (const line of lines) {
    const m = /^\s*(\d+)\s+(\w+\s+\w+\s+\d+\s+[\d:]+\s+\d+)\s+(.*)$/.exec(line);
    if (!m || !/com\.apple\.WebKit\.(WebContent|Networking|GPU)/.test(m[3])) continue;
    const started = new Date(m[2]).getTime();
    if (started >= t0 - 1500) out.push({ pid: Number(m[1]), name: m[3].split('.').pop() });
  }
  return out;
}

function secs(text) {
  const parts = text.trim().split(':').map(Number);
  return parts.reduce((a, b) => a * 60 + b, 0);
}

function sampleProcs(procs) {
  const out = {};
  for (const p of procs) {
    try {
      const [time, rss] = execFileSync('ps', ['-o', 'time=,rss=', '-p', String(p.pid)], { encoding: 'utf8' }).trim().split(/\s+/);
      out[p.name] = { pid: p.pid, cpuSecs: secs(time), rssMb: Math.round(Number(rss) / 102.4) / 10 };
    } catch {
      out[p.name] = { pid: p.pid, cpuSecs: 0, rssMb: 0, gone: true };
    }
  }
  return out;
}

/** top's two-sample mode: the second sample covers the interval. Wakeups are per interval there. */
function topSample(procs, seconds) {
  // top takes one -pid only, so it lists everything and the rows are picked out by pid.
  const args = ['-l', '2', '-s', String(seconds), '-stats', 'pid,cpu,idlew,mem'];
  const text = execFileSync('top', args, { encoding: 'utf8', maxBuffer: 1 << 24 });
  const blocks = text.split(/^PID\s+/m);
  const last = blocks[blocks.length - 1].split('\n').slice(1);
  const out = {};
  for (const line of last) {
    const m = /^\s*(\d+)\s+([\d.]+)\s+(\d+)\s+(\S+)/.exec(line);
    if (!m) continue;
    const p = procs.find((x) => x.pid === Number(m[1]));
    if (p) out[p.name] = { cpuPct: Number(m[2]), idleWakeups: Number(m[3]), mem: m[4] };
  }
  return out;
}

const COLD_SCRIPT = (t0) => `run(async () => {
  await until(() => performance.getEntriesByName('z-first-render').length > 0, 'first render');
  const mark = performance.getEntriesByName('z-first-render')[0].startTime;
  return { pageStartMs: performance.timeOrigin - ${t0}, firstRenderMs: performance.timeOrigin + mark - ${t0} };
});`;

const SETUP_SCRIPT = (hide) => `run(async () => {
  await until(() => document.querySelector('#root').children.length, 'render');
  const s = await inv('get_snapshot');
  const project = s.projects[0].id;
  const doc = { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'perf' }] }] };
  const t = await inv('create_task', { input: { name: 'Perf run', projectId: project, description: doc, tags: ['tag-concept'] } });
  await inv('start_task', { id: t.id });
  ${hide ? "await inv('smoke_close_window');" : ''}
  await wait(500);
  return { visible: await inv('smoke_window_visible'), segments: s.segments.length };
});`;

const results = { exe: EXE, store: STORE, cold: null, idle: {} };
const work = mkdtempSync(join(tmpdir(), 'z-work-perf-'));
const data = join(work, 'data');
let current = null;

function freshStore() {
  rmSync(data, { recursive: true, force: true });
  if (STORE) cpSync(STORE, data, { recursive: true });
}

try {
  freshStore();
  const firsts = [];
  const pages = [];
  for (let i = 0; i < COLD_RUNS; i += 1) {
    const t0 = Date.now();
    const app = launch(work, COLD_SCRIPT(t0));
    current = app;
    const r = await waitJson(app.out);
    await quit(app);
    current = null;
    if (!r || r.error) throw new Error(`cold start failed: ${JSON.stringify(r)}`);
    if (i > 0) {
      // The first launch fills the system's caches for this binary; it is reported on its own.
      firsts.push(r.firstRenderMs);
      pages.push(r.pageStartMs);
    } else results.coldFirstLaunchMs = r.firstRenderMs;
  }
  results.cold = { firstRenderMedianMs: Math.round(median(firsts)), firstRenderMinMs: Math.round(Math.min(...firsts)), firstRenderMaxMs: Math.round(Math.max(...firsts)), pageStartMedianMs: Math.round(median(pages)), n: firsts.length };
  console.log('cold', JSON.stringify(results.cold), 'first launch', results.coldFirstLaunchMs);

  for (const [label, hide] of [['hidden, task running', true], ['visible, task running', false]]) {
    freshStore();
    const app = launch(work, SETUP_SCRIPT(hide));
    current = app;
    const r = await waitJson(app.out);
    if (!r || r.error) throw new Error(`setup failed: ${JSON.stringify(r)}`);
    await sleep(5000);
    const procs = [{ pid: app.child.pid, name: 'main' }, ...helpers(app.t0)];
    const a = sampleProcs(procs);
    const started = Date.now();
    const top = topSample(procs, WINDOW_S);
    const elapsed = (Date.now() - started) / 1000;
    const b = sampleProcs(procs);
    const per = {};
    for (const p of procs) {
      per[p.name] = { cpuSecs: Math.round((b[p.name].cpuSecs - a[p.name].cpuSecs) * 100) / 100, cpuPct: Math.round(((b[p.name].cpuSecs - a[p.name].cpuSecs) / elapsed) * 1000) / 10, rssMb: b[p.name].rssMb, idleWakeupsPerSec: top[p.name] ? Math.round((top[p.name].idleWakeups / WINDOW_S) * 10) / 10 : null, topCpuPct: top[p.name]?.cpuPct ?? null, mem: top[p.name]?.mem ?? null };
    }
    results.idle[label] = { windowSecs: Math.round(elapsed), visible: r.visible, per };
    console.log(label, JSON.stringify(results.idle[label]));
    await quit(app);
    current = null;
  }
  if (OUT) writeFileSync(OUT, JSON.stringify(results, null, 2));
} finally {
  if (current) current.child.kill('SIGKILL');
  rmSync(work, { recursive: true, force: true });
}
