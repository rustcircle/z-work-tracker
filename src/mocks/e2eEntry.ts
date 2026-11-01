// Entry for the e2e build. `?seed=demo` (default), `?seed=p2` (the demo plus every phase 2 feature) or `?seed=empty`, `?theme=`, `?firstRun=1` (the wizard; `&step=N` resumes at a saved step, `&pc=2` is a second computer whose OneDrive folder already holds data) or `?firstRun=legacy` (the old prompts), `?launch=cold`.
import { emit } from '@tauri-apps/api/event';

import { toIso } from '../lib/tz';
import type { Theme } from '../lib/types';
import { demoP2State, demoState } from './demoSeed';
import { fullProject } from './factories';
import { DEVICE_ID, crashRelaunch, emptyState, installMock, relaunch, type MockState } from './ipcMock';

declare global {
  interface Window {
    __mock: MockState;
    __mockRelaunch: (kind: 'quit' | 'crash') => void;
    /** Fires a backend event at the app, such as 'state-changed', 'cold-resume' or 'flush-edits'. */
    __mockEmit: (event: string, payload?: unknown) => Promise<void>;
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
  if (q.get('sync') === '1') seedSync(state);
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
  installMock(state);
}
