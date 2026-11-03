// Entry for the e2e build. `?seed=demo` (default), `?seed=p2` (the demo plus every phase 2 feature) or `?seed=empty`, `?theme=`, `?firstRun=1` (the wizard; `&step=N` resumes at a saved step, `&pc=2` is a second computer whose OneDrive folder already holds data) or `?firstRun=legacy` (the old prompts), `?mica=1`, `?launch=cold`.
// Single-device lease: `?lease=live|stale|unknown|mine` (another computer holds it, looks inactive, no folder can be read, this computer holds it), or `free`,
// `checking`, `unknown-writable`; each connects a folder when none is. `?versions=1` (two folders and seven saved versions), `?packaged=1` (a Microsoft Store build),
// `?autostart=offByUser|offByPolicy|onByPolicy|unavailable|on|off` (Start with Windows as Windows reports it) and `?join=1` (a folder waiting for a choice).
import { emit } from '@tauri-apps/api/event';

import { toIso } from '../lib/tz';
import type { LeaseHolderView, Theme } from '../lib/types';
import { demoP2State, demoState } from './demoSeed';
import { fullProject } from './factories';
import { DEVICE_ID, crashRelaunch, emptyState, installMock, isAutostartState, isLeaseSeed, loseLease, relaunch, seedJoinPending, seedLease, seedVersions, type MockState } from './ipcMock';

declare global {
  interface Window {
    __mock: MockState;
    __mockRelaunch: (kind: 'quit' | 'crash') => void;
    /** Fires a backend event at the app, such as 'state-changed', 'cold-resume' or 'flush-edits'. */
    __mockEmit: (event: string, payload?: unknown) => Promise<void>;
    /** Another computer takes the lease over while this one holds it: a running task closes, this computer turns read-only, and the page is told. `by` describes the new holder. */
    __mockLeaseLost: (by?: Partial<LeaseHolderView>) => void;
  }
}

/** `?sync=1`: a OneDrive folder in use with data from two PCs, and a Google Drive folder found but not connected. */
function seedSync(state: MockState): void {
  const root = 'C:\\Users\\me\\OneDrive';
  const stamp = toIso(state.now);
  state.targets = [
    { provider: 'oneDrive', root, folder: `${root}\\zWorkTracker`, status: { lastWrittenAt: stamp, lastReadAt: stamp, lastError: null, lastErrorAt: null, warnings: [], ignoredFiles: 0, devicesSeen: 1 } },
  ];
  state.detected = [{ provider: 'googleDrive', root: 'G:\\My Drive', source: 'a mounted drive' }];
  state.folders = { [root]: { devices: ['Office PC', 'Mock PC'], counts: { projects: 4, tasks: 12, segments: 300 }, available: true } };
  state.syncPromptDone = true;
}

/** `?pc=2`: this is a second computer. A detected OneDrive folder already holds the first one's records. */
function seedSecondPc(state: MockState): void {
  const root = 'C:\\Users\\me\\OneDrive';
  const stamp = { at: toIso(state.now), by: DEVICE_ID };
  state.detected = [{ provider: 'oneDrive', root, source: 'the OneDrive folder' }];
  state.folders[root] = {
    devices: ['Office PC'],
    counts: { projects: 1, tasks: 6, segments: 48 },
    available: true,
    data: {
      projects: [fullProject({ id: 'p-office', name: 'Office project', color: '#2563eb' })],
      settings: { myZone: 'Europe/Lisbon' },
      rounding: [{ id: 'r-office', projectId: null, effectiveFrom: '2026-01-01', incrementMinutes: 15, method: 'up', deleted: false, stamp }],
      shifts: [],
    },
  };
}

export function installE2eBackend(): void {
  const q = new URLSearchParams(window.location.search);
  const seed = q.get('seed');
  const state = seed === 'empty' ? emptyState() : seed === 'p2' ? demoP2State() : demoState();
  const theme = q.get('theme');
  if (theme) state.theme = theme as Theme;
  if (q.get('hide') === '1') state.hideEarnings = true;
  if (q.get('showBoth') === '1') state.settings.showBoth = true;
  // `firstRun=1`: a fresh store, which shows the setup wizard. `firstRun=legacy`: someone who updated before the
  // wizard existed and still owes the two one-time prompts, which keep appearing as they did.
  const firstRun = q.get('firstRun');
  if (firstRun === '1' || firstRun === 'legacy') {
    state.setupDone = firstRun === 'legacy';
    state.syncPromptDone = false;
    state.clientZonePromptDone = false;
    state.settings.clientZone = null;
    if (firstRun === '1') {
      state.settings = {};
      state.setupStep = Number(q.get('step') ?? '0') || 0;
    }
    if (q.get('pc') === '2') seedSecondPc(state);
  }
  // `mica=1`: a system that can show Mica (Windows 11), for the setting's enabled state.
  if (q.get('mica') === '1') state.micaAvailable = true;
  if (q.get('sync') === '1') seedSync(state);
  const lease = q.get('lease');
  if (lease !== null) {
    if (!isLeaseSeed(lease)) throw new Error(`?lease= must be one of live, stale, unknown, mine, free, checking, unknown-writable; got "${lease}"`);
    if (state.targets.length === 0) seedSync(state);
    seedLease(state, lease);
  }
  if (q.get('versions') === '1') {
    if (state.targets.length === 0) seedSync(state);
    seedVersions(state);
  }
  if (q.get('join') === '1') seedJoinPending(state);
  if (q.get('packaged') === '1') state.packaged = true;
  const autostart = q.get('autostart');
  if (autostart !== null) {
    if (!isAutostartState(autostart)) throw new Error(`?autostart= must be on, off, offByUser, offByPolicy, onByPolicy or unavailable; got "${autostart}"`);
    state.autostartInfo = { ...state.autostartInfo, state: autostart };
  }
  if (q.get('launch') === 'cold') relaunch(state);
  window.__mock = state;
  // A real relaunch restarts the page and the process: the test reloads nothing but the launch state.
  window.__mockRelaunch = (kind) => {
    if (kind === 'crash') crashRelaunch(state);
    else relaunch(state);
    // The real app would start a fresh process and load a fresh snapshot; here the backend tells it to.
    void emit('state-changed');
  };
  window.__mockEmit = (event, payload) => emit(event, payload);
  window.__mockLeaseLost = (by) => {
    loseLease(state, by);
    void emit('state-changed');
  };
  installMock(state);
}
