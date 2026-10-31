// Entry for the e2e build. `?seed=demo` (default) or `?seed=empty`, `?theme=`, `?firstRun=1`.
import type { Theme } from '../lib/types';
import { demoState } from './demoSeed';
import { emptyState, installMock, type MockState } from './ipcMock';

declare global {
  interface Window {
    __mock: MockState;
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
  window.__mock = state;
  installMock(state);
}
