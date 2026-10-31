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
  clearSettingsSection: () => void;
  /** A request to bring a task into view in the rail, and to open its editor if `edit`. */
  focusTask: { id: string; edit: boolean; seq: number } | null;
  goToTask: (id: string, edit?: boolean) => void;
  clearFocusTask: () => void;
  /** A paused task the cold-start form should continue, or null. */
  continueTaskId: string | null;
  openContinue: (id: string) => void;
  clearContinue: () => void;
  /** An item whose colour the "colour was replaced" notice asked to choose again. */
  colorTarget: { kind: 'project' | 'tag'; id: string } | null;
  chooseColor: (kind: 'project' | 'tag', id: string) => void;
  clearColorTarget: () => void;
  /**
   * "New tag" pressed next to a tag picker: Settings > Tags opens with the Add tag form, and a way back
   * to the tab the user came from. `createdId` is the tag made meanwhile, for the picker to select.
   */
  tagIntent: { origin: string; back: TabId; createdId: string | null } | null;
  startNewTag: (origin: string) => void;
  tagCreated: (id: string) => void;
  /** Return from Settings to where the tag was asked for. */
  backToTask: () => void;
  /** The picker (by origin) that should take focus after coming back. */
  returnFocus: string | null;
  clearReturnFocus: () => void;
  endTagIntent: () => void;
}

export const NavContext = createContext<Nav | null>(null);

/** The nav if there is one; small components used on their own in tests have none. */
export function useOptionalNav(): Nav | null {
  return useContext(NavContext);
}

export function useNav(): Nav {
  const v = useContext(NavContext);
  if (!v) throw new Error('useNav needs NavContext');
  return v;
}
