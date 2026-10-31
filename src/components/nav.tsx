// Which tab is showing, and a way for any component to jump to a project's editor.
import { createContext, useContext } from 'react';

export type TabId = 'timeline' | 'analysis' | 'billing' | 'projects' | 'settings';

export interface Nav {
  tab: TabId;
  go: (tab: TabId) => void;
  /** Project the Projects tab should open for editing, if any. */
  focusProject: string | null;
  openProject: (id: string) => void;
  clearFocusProject: () => void;
  /** Section the Settings tab should scroll to, if any. */
  openSettings: (section: string) => void;
  settingsSection: string | null;
  /** A request to bring a task into view in the rail, and to open its editor if `edit`. */
  focusTask: { id: string; edit: boolean; seq: number } | null;
  goToTask: (id: string, edit?: boolean) => void;
  clearFocusTask: () => void;
  /** A paused task the cold-start form should continue, or null. */
  continueTaskId: string | null;
  openContinue: (id: string) => void;
  clearContinue: () => void;
}

export const NavContext = createContext<Nav | null>(null);

export function useNav(): Nav {
  const v = useContext(NavContext);
  if (!v) throw new Error('useNav needs NavContext');
  return v;
}
