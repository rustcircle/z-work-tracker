// "Run setup again" in Settings opens the wizard from outside the Shell. The backend only knows whether the
// first run is pending; a rerun is a screen, not a state of the data, so it lives here.
import { createContext, useContext, useMemo, useState, type ReactNode } from 'react';

interface SetupApi {
  rerun: boolean;
  startRerun: () => void;
  endRerun: () => void;
}

const Ctx = createContext<SetupApi | null>(null);

export function SetupProvider({ children }: { children: ReactNode }) {
  const [rerun, setRerun] = useState(false);
  const value = useMemo<SetupApi>(() => ({ rerun, startRerun: () => setRerun(true), endRerun: () => setRerun(false) }), [rerun]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

const NONE: SetupApi = { rerun: false, startRerun: () => undefined, endRerun: () => undefined };
export const useSetup = (): SetupApi => useContext(Ctx) ?? NONE;
