// Entry for the e2e build. `?seed=demo` (default) or `?seed=empty`, `?theme=`, `?firstRun=1`, `?launch=cold`.
import { emit } from '@tauri-apps/api/event';

import type { Theme } from '../lib/types';
import { demoState } from './demoSeed';
import { crashRelaunch, emptyState, installMock, relaunch, type MockState } from './ipcMock';

declare global {
  interface Window {
    __mock: MockState;
    __mockRelaunch: (kind: 'quit' | 'crash') => void;
    /** Fires a backend event at the app, such as 'state-changed', 'cold-resume' or 'flush-edits'. */
    __mockEmit: (event: string, payload?: unknown) => Promise<void>;
  }
}

export function installE2eBackend(): void {
  const q = new URLSearchParams(window.location.search);
  const state = q.get('seed') === 'empty' ? emptyState() : demoState();
  const theme = q.get('theme');
  if (theme) state.theme = theme as Theme;
  if (q.get('hide') === '1') state.hideEarnings = true;
  if (q.get('showBoth') === '1') state.settings.showBoth = true;
  if (q.get('firstRun') === '1') {
    state.syncPromptDone = false;
    state.clientZonePromptDone = false;
    state.settings.clientZone = null;
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
  installMock(state);
}
