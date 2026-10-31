#!/usr/bin/env node
// Measures the production-shaped e2e bundle in headless Chromium, against the IPC mock, at a large data
// size. It says how the page behaves, not how WebKit or WebView2 behave and not what the real backend
// costs: the mock's snapshot time is measured separately so it can be left out.
//
//   pnpm build:e2e && node scripts/perf-frontend.mjs --out perf.json [--segments 50000] [--repeat 7]
//
// Set PERF_PROFILE=<dir> to also save CPU profiles (build with --minify false for readable names).
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { chromium } from '@playwright/test';

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
};
const SEGMENTS = Number(arg('segments', 50_000));
const REPEAT = Number(arg('repeat', 7));
const OUT = arg('out', null);
const PORT = Number(arg('port', 4183));
const DIST = arg('dist', 'dist-e2e');
const PROFILE = process.env.PERF_PROFILE ?? null;
const BASE = `http://localhost:${PORT}`;

const server = spawn('pnpm', ['exec', 'vite', 'preview', '--outDir', DIST, '--port', String(PORT), '--strictPort'], { stdio: 'ignore', detached: true });
const stopServer = () => {
  try {
    process.kill(-server.pid);
  } catch {
    /* already gone */
  }
};
process.on('exit', stopServer);

async function waitForServer() {
  for (let i = 0; i < 100; i += 1) {
    try {
      if ((await fetch(BASE)).ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('preview server did not start');
}

const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
const round = (x) => Math.round(x * 10) / 10;
function stats(xs) {
  const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
  const sd = Math.sqrt(xs.reduce((a, b) => a + (b - mean) ** 2, 0) / xs.length);
  return { medianMs: round(median(xs)), minMs: round(Math.min(...xs)), maxMs: round(Math.max(...xs)), cv: mean > 0 ? Math.round((sd / mean) * 1000) / 1000 : 0, n: xs.length };
}

/** Runs in the page: fills the mock with the same shape of data as the Rust bench and perf.perf.test.ts. */
function seed(segments) {
  const m = window.__mock;
  let a = 7;
  const rand = () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const iso = (s) => new Date(s * 1000).toISOString().replace('.000Z', 'Z');
  const start = Date.UTC(2024, 0, 1) / 1000;
  const days = 1095;
  // The last day of the data, so that week, month, quarter and year all hold real work.
  const now = start + (days - 1) * 86400 + 15 * 3600;
  const stamp = { at: iso(start), by: '' };
  m.now = now;
  m.projects = Array.from({ length: 12 }, (_, i) => ({ id: `p${i}`, name: `Project ${i}`, color: ['#2563eb', '#dc2626', '#059669', '#d97706'][i % 4], archived: false, billable: true, budgetHours: i % 3 === 0 ? 800 : null, clientZone: null, createdAt: iso(start), hasTasks: true }));
  m.rates = m.projects.map((p, i) => ({ id: `r${i}`, projectId: p.id, effectiveFrom: iso(start), rateCents: 4000 + i * 500, currency: i % 2 ? 'USD' : 'EUR', deleted: false, stamp }));
  m.tasks = Array.from({ length: 400 }, (_, i) => ({ id: `t${i}`, name: `Task ${i}`, projectId: `p${i % 12}`, description: null, state: i === 0 ? 'running' : i % 13 === 0 ? 'paused' : 'stopped', pauseReason: i % 13 === 0 && i > 0 ? { kind: 'user' } : null, createdAt: iso(start), stoppedAt: i % 13 === 0 ? null : iso(now), runningElsewhere: null, continuedFrom: null, tags: i % 5 === 0 ? ['tag-concept'] : [] }));
  const segs = [];
  const perDay = Math.ceil(segments / (days - 1));
  for (let d = 0; d < days - 1 && segs.length < segments; d += 1) {
    let cursor = start + d * 86400 + 6 * 3600 + Math.floor(rand() * 7200);
    for (let k = 0; k < perDay && segs.length < segments; k += 1) {
      const len = 120 + Math.floor(rand() * 1800);
      segs.push({ id: `s${segs.length}`, taskId: `t${Math.floor(rand() * 400)}`, deviceId: m.deviceId ?? '11111111-1111-4111-8111-111111111111', start: iso(cursor), end: iso(cursor + len), provisionalEnd: null });
      cursor += len + Math.floor(rand() * 600);
    }
  }
  segs.push({ id: 'live', taskId: 't0', deviceId: '11111111-1111-4111-8111-111111111111', start: iso(now - 1800), end: null, provisionalEnd: null });
  m.segments = segs;
  m.gaps = [];
  m.pauses = [];
  m.shifts = [];
  m.settings = { ...m.settings, myZone: 'Europe/Lisbon', clientZone: 'America/New_York', dailyTargetHours: 6, weeklyTargetHours: 30 };
  return segs.length;
}

/** Runs in the page: acts, then waits for the frame that shows it and the task after it. */
const IN_PAGE = `
window.__measure = (fn) => new Promise((resolve) => {
  const t0 = performance.now();
  fn();
  requestAnimationFrame(() => setTimeout(() => resolve(performance.now() - t0), 0));
});
window.__byText = (sel, text, root) => [...(root ?? document).querySelectorAll(sel)].find((e) => e.textContent.trim() === text);
window.__setValue = (el, value) => {
  const proto = el.tagName === 'SELECT' ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, value);
  el.dispatchEvent(new Event(el.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true }));
};
`;

const results = { segments: SEGMENTS, browser: null, timing: {}, ticks: {}, heap: {}, map: {}, sizes: {} };

async function metrics(cdp) {
  const { metrics: list } = await cdp.send('Performance.getMetrics');
  return Object.fromEntries(list.map((m) => [m.name, m.value]));
}

async function coldStart(browser) {
  const runs = [];
  for (let i = 0; i < REPEAT; i += 1) {
    const ctx = await browser.newContext({ viewport: { width: 1360, height: 900 } });
    const page = await ctx.newPage();
    await page.addInitScript(() => {
      new MutationObserver((_, o) => {
        if (document.querySelector('.timeline')) {
          window.__interactive = performance.now();
          o.disconnect();
        }
      }).observe(document, { childList: true, subtree: true });
    });
    await page.goto(`${BASE}/?seed=demo`);
    await page.waitForSelector('.timeline');
    runs.push(await page.evaluate(() => window.__interactive));
    await ctx.close();
  }
  results.timing['cold load to timeline (demo seed, browser cache cold)'] = stats(runs);
}

async function mapPicker(browser) {
  const runs = [];
  for (let i = 0; i < REPEAT; i += 1) {
    const ctx = await browser.newContext({ viewport: { width: 1360, height: 900 } });
    const page = await ctx.newPage();
    await page.goto(`${BASE}/?seed=demo`);
    await page.waitForSelector('.timeline');
    const ms = await page.evaluate(
      () =>
        new Promise((resolve) => {
          const t0 = performance.now();
          const done = () => {
            if (document.querySelector('[data-testid="zone-map-countries"] path') && document.querySelector('[data-pin="mine"]')) resolve(performance.now() - t0);
            else setTimeout(done, 5);
          };
          [...document.querySelectorAll('button')].find((b) => /^Other/.test(b.textContent.trim())).click();
          done();
        }),
    );
    runs.push(ms);
    await ctx.close();
  }
  results.map['open picker until map drawn (cold)'] = stats(runs);
}

async function run() {
  await waitForServer();
  const browser = await chromium.launch({ headless: true, args: ['--enable-precise-memory-info', '--js-flags=--expose-gc'] });
  results.browser = browser.version();
  await coldStart(browser);
  await mapPicker(browser);

  const ctx = await browser.newContext({ viewport: { width: 1360, height: 900 } });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`${BASE}/?seed=demo`);
  await page.waitForSelector('.timeline');
  await page.evaluate(IN_PAGE);
  const cdp = await ctx.newCDPSession(page);
  await cdp.send('Performance.enable');
  await cdp.send('HeapProfiler.enable');

  const count = await page.evaluate(seed, SEGMENTS);
  console.log(`seeded ${count} segments`);
  const mockMs = await page.evaluate(async () => {
    const out = [];
    for (let i = 0; i < 3; i += 1) {
      const t0 = performance.now();
      await window.__TAURI_INTERNALS__.invoke('get_snapshot');
      out.push(performance.now() - t0);
    }
    return out;
  });
  results.timing['mock get_snapshot (not the app, subtract from snapshot adoption)'] = stats(mockMs);
  const decode = await page.evaluate(async () => {
    const snap = await window.__TAURI_INTERNALS__.invoke('get_snapshot');
    const text = JSON.stringify(snap);
    const out = [];
    for (let i = 0; i < 7; i += 1) {
      const t0 = performance.now();
      JSON.parse(text);
      out.push(performance.now() - t0);
    }
    return { out, bytes: text.length, segments: snap.segments.length, raw: snap.rawSegments.length };
  });
  results.timing['JSON.parse of a snapshot (what the real IPC pays)'] = stats(decode.out);
  results.sizes.snapshotChars = decode.bytes;
  results.sizes.snapshotSegments = decode.segments;

  const emit = () => page.evaluate(() => window.__mockEmit('state-changed'));
  const settle = async () => {
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0))));
  };
  await emit();
  await page.waitForFunction((n) => (document.body.innerText || '').length > 0 && n > 0, count);
  await page.waitForTimeout(3000);
  await settle();

  const clickTab = (name) => `window.__measure(() => document.getElementById('tab-${name}').click())`;
  const measure = async (label, expr, n = REPEAT, between = null) => {
    const xs = [];
    for (let i = 0; i < n; i += 1) {
      if (between) await page.evaluate(between);
      xs.push(await page.evaluate(expr));
      await settle();
    }
    results.timing[label] = stats(xs);
    console.log(`${label}: ${results.timing[label].medianMs} ms (cv ${results.timing[label].cv})`);
  };
  const profile = async (name, fn) => {
    if (!PROFILE) return fn();
    mkdirSync(PROFILE, { recursive: true });
    await cdp.send('Profiler.enable');
    await cdp.send('Profiler.setSamplingInterval', { interval: 500 });
    await cdp.send('Profiler.start');
    const out = await fn();
    const { profile: p } = await cdp.send('Profiler.stop');
    writeFileSync(join(PROFILE, `${name}.cpuprofile`), JSON.stringify(p));
    return out;
  };

  // Timeline and Analysis, from a light tab, so each mount pays for its own charts.
  await profile('timeline-mount', () => measure('tab: Settings to Timeline (first page of days)', clickTab('timeline'), REPEAT, "document.getElementById('tab-settings').click()"));
  await profile('analysis-mount', () => measure('tab: Settings to Analysis (default range)', clickTab('analysis'), REPEAT, "document.getElementById('tab-settings').click()"));

  await page.evaluate("document.getElementById('tab-analysis').click()");
  await settle();
  const seg = (text) => `window.__measure(() => window.__byText('.a-seg-btn', '${text}').click())`;
  await measure('range: to Month', seg('Month'), REPEAT, "window.__byText('.a-seg-btn', 'Week').click()");
  await measure('range: to Quarter', seg('Quarter'), REPEAT, "window.__byText('.a-seg-btn', 'Week').click()");
  await measure('range: to Year', seg('Year'), REPEAT, "window.__byText('.a-seg-btn', 'Week').click()");
  await page.evaluate("window.__byText('.a-seg-btn', 'Custom').click()");
  await settle();
  const setFrom = (d) => `window.__measure(() => window.__setValue(document.querySelector('.a-controls input[type=date]'), '${d}'))`;
  await page.evaluate("window.__setValue([...document.querySelectorAll('.a-controls input[type=date]')][1], '2026-12-31')");
  await settle();
  await profile('analysis-3y', () => measure('range: custom, 3 years, every chart', setFrom('2024-01-01'), REPEAT, "window.__setValue(document.querySelector('.a-controls input[type=date]'), '2026-12-01')"));
  await page.evaluate("window.__setValue(document.querySelector('.a-controls input[type=date]'), '2024-01-01')");
  await settle();
  await measure('3y: toggle compare', "window.__measure(() => document.querySelector('.a-controls input[type=checkbox]').click())");
  await measure('3y: basis Billable/Exact', "window.__measure(() => window.__byText('.a-seg-btn', document.querySelector('[aria-label=\"Time basis\"] [aria-checked=true]').textContent.trim() === 'Billable' ? 'Exact' : 'Billable').click())");
  await measure('3y: project filter on/off', "window.__measure(() => document.querySelector('.a-menu-body input[type=checkbox]').click())");
  await measure('3y: task filter', "window.__measure(() => { const s = [...document.querySelectorAll('.a-controls select')][0]; window.__setValue(s, s.value ? '' : 't1'); })");

  // Zone switching goes through the backend and a fresh snapshot, as in the app.
  const zoneBtn = (text) => `window.__byText('.zn-seg-btn', '${text}')`;
  const waitZone = (fn) =>
    page.evaluate(
      async (body) => {
        const t0 = performance.now();
        await new Promise((resolve) => {
          const go = new Function('return ' + body);
          const before = document.querySelector('[data-testid="active-zone-label"]').textContent;
          go().click();
          const poll = () => {
            if (document.querySelector('[data-testid="active-zone-label"]').textContent !== before) requestAnimationFrame(() => setTimeout(resolve, 0));
            else setTimeout(poll, 1);
          };
          poll();
        });
        return performance.now() - t0;
      },
      fn,
    );
  const zoneTimes = async (label) => {
    const xs = [];
    for (let i = 0; i < REPEAT; i += 1) {
      const onMy = await page.evaluate(`${zoneBtn('My time')}.getAttribute('aria-pressed') === 'true'`);
      xs.push(await waitZone(zoneBtn(onMy ? 'Client time' : 'My time')));
      await page.waitForTimeout(100);
    }
    results.timing[label] = stats(xs);
    console.log(`${label}: ${results.timing[label].medianMs} ms`);
  };
  await profile('zone-analysis', () => zoneTimes('zone switch on Analysis 3y (includes mock snapshot)'));
  await page.evaluate("document.getElementById('tab-timeline').click()");
  await settle();
  await profile('zone-timeline', () => zoneTimes('zone switch on Timeline (includes mock snapshot)'));
  await page.evaluate(`window.__measure(() => ${zoneBtn('My time')}.click())`);
  await page.waitForTimeout(1500);

  // What a fresh snapshot costs each tab: every action and sync reply goes through this.
  const adoption = async (label) => {
    const xs = [];
    for (let i = 0; i < REPEAT; i += 1) {
      const ms = await page.evaluate(async () => {
        const t0 = performance.now();
        const seen = new Promise((resolve) => {
          const orig = window.__TAURI_INTERNALS__.invoke;
          window.__TAURI_INTERNALS__.invoke = async (...a) => {
            const r = await orig(...a);
            window.__TAURI_INTERNALS__.invoke = orig;
            resolve();
            return r;
          };
        });
        await window.__mockEmit('state-changed');
        await seen;
        await new Promise((r) => setTimeout(r, 0));
        await new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)));
        return performance.now() - t0;
      });
      xs.push(ms);
      await page.waitForTimeout(50);
    }
    results.timing[label] = stats(xs);
    console.log(`${label}: ${results.timing[label].medianMs} ms`);
  };
  await adoption('fresh snapshot on Timeline (includes mock snapshot)');
  await page.evaluate("document.getElementById('tab-analysis').click()");
  await settle();
  await adoption('fresh snapshot on Analysis (includes mock snapshot)');
  await page.evaluate("document.getElementById('tab-timeline').click()");
  await settle();

  // Live ticks: page work per second with the app left on a tab.
  const idle = async (label, seconds, setup = null) => {
    if (setup) await page.evaluate(setup);
    await page.waitForTimeout(2500);
    const a = await metrics(cdp);
    await page.waitForTimeout(seconds * 1000);
    const b = await metrics(cdp);
    const per = (k) => round(((b[k] - a[k]) * 1000) / seconds);
    results.ticks[label] = { taskMsPerSec: per('TaskDuration'), scriptMsPerSec: per('ScriptDuration'), layoutMsPerSec: per('LayoutDuration'), styleMsPerSec: per('RecalcStyleDuration'), layoutsPerSec: round((b.LayoutCount - a.LayoutCount) / seconds), seconds };
    console.log(`${label}: ${JSON.stringify(results.ticks[label])}`);
  };
  const HIDE = "Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' }); Object.defineProperty(document, 'hidden', { configurable: true, get: () => true }); document.dispatchEvent(new Event('visibilitychange'));";
  const SHOW = "delete document.visibilityState; delete document.hidden; document.dispatchEvent(new Event('visibilitychange'));";
  await profile('tick-timeline', () => idle('Timeline open, task running', 12));
  await idle('Timeline, hidden', 12, HIDE);
  await page.evaluate(SHOW);
  await page.evaluate("document.getElementById('tab-analysis').click()");
  await idle('Analysis (default range) open, task running', 12);
  await page.evaluate("window.__byText('.a-seg-btn', 'Year').click()");
  await profile('tick-analysis', () => idle('Analysis, Year range, task running', 12));
  await idle('Analysis, hidden', 12, HIDE);
  await page.evaluate(SHOW);
  await page.evaluate("document.getElementById('tab-settings').click()");
  await idle('Settings open, task running', 12);

  // Leaks: repeated tab and range switches, with garbage collected before each reading.
  const leakCycles = Number(arg('cycles', 200));
  const samples = [];
  const reading = async (cycle) => {
    await cdp.send('HeapProfiler.collectGarbage');
    await cdp.send('HeapProfiler.collectGarbage');
    const m = await metrics(cdp);
    samples.push({ cycle, heapMb: round(m.JSHeapUsedSize / 1048576), nodes: m.Nodes, listeners: m.JSEventListeners, documents: m.Documents });
  };
  await reading(0);
  for (let i = 1; i <= leakCycles; i += 1) {
    await page.evaluate(async () => {
      const tab = (n) => document.getElementById(`tab-${n}`).click();
      const frame = () => new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)));
      tab('analysis');
      await frame();
      window.__byText('.a-seg-btn', 'Week').click();
      await frame();
      window.__byText('.a-seg-btn', 'Month').click();
      await frame();
      tab('timeline');
      await frame();
      tab('projects');
      await frame();
      tab('billing');
      await frame();
      tab('settings');
      await frame();
    });
    if (i % 25 === 0) await reading(i);
  }
  results.heap = { samples };
  console.log('heap', JSON.stringify(samples));
  results.errors = errors;
  await browser.close();
}

try {
  await run();
  if (OUT) writeFileSync(OUT, JSON.stringify(results, null, 2));
  console.log(JSON.stringify(results.timing, null, 1));
} finally {
  stopServer();
}
