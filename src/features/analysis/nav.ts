// Jumps to other tabs through the shell's navigation context. Outside the shell (component tests)
// the links simply do nothing.
import { useContext, useMemo } from 'react';

import { NavContext } from '../../components/nav';

export interface Jumps {
  openProject: (id: string) => void;
  openSettings: (section: 'targets' | 'shifts' | 'zones' | 'rounding') => void;
}

export function useJumps(): Jumps {
  const nav = useContext(NavContext);
  return useMemo<Jumps>(() => ({ openProject: (id) => nav?.openProject(id), openSettings: (s) => nav?.openSettings(s) }), [nav]);
}
