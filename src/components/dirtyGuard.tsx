// Only the open tab is mounted, so a form on a tab is gone as soon as another tab is shown. A form with changes that are not
// saved says so with `useDirtyGuard(dirty)`; whoever changes the tab goes through `useLeaveCheck()`, which asks first.
import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';

import { ConfirmDialog } from './ui';

interface Registry {
  /** A form has changes that are not saved. Returns the way to say it has none any more. */
  hold: () => () => void;
  /** Runs `go` now when no form holds unsaved changes, otherwise once the user agrees to lose them. */
  leave: (go: () => void) => void;
}

const DirtyContext = createContext<Registry | null>(null);

/** Put above whatever changes the tab. It also draws the question. */
export function DirtyGuardProvider({ children }: { children: ReactNode }) {
  const holding = useRef(0);
  const [asking, setAsking] = useState<{ go: () => void } | null>(null);
  const registry = useMemo<Registry>(
    () => ({
      hold: () => {
        holding.current += 1;
        let held = true;
        return () => {
          if (!held) return;
          held = false;
          holding.current -= 1;
        };
      },
      leave: (go) => {
        if (holding.current === 0) go();
        else setAsking({ go });
      },
    }),
    [],
  );
  return (
    <DirtyContext.Provider value={registry}>
      {children}
      <ConfirmDialog
        open={asking !== null}
        title="Leave without saving?"
        confirmLabel="Leave and discard"
        cancelLabel="Keep editing"
        danger
        onCancel={() => setAsking(null)}
        onConfirm={() => {
          const leaving = asking;
          setAsking(null);
          leaving?.go();
        }}
      >
        <p>The form on this tab has changes that are not saved. If you leave now, they are lost.</p>
      </ConfirmDialog>
    </DirtyContext.Provider>
  );
}

/**
 * Called by a form that lives on a tab, on every render, with whether its values differ from what it opened with. While `dirty`
 * is true, leaving the tab asks first. A form that closes after saving or cancelling stops counting when it goes. Without a
 * provider above it (a form used on its own) it does nothing.
 */
export function useDirtyGuard(dirty: boolean): void {
  const registry = useContext(DirtyContext);
  useEffect(() => (dirty ? registry?.hold() : undefined), [dirty, registry]);
}

const NO_GUARD = (go: () => void): void => go();

/** For whoever changes the tab: `leave(() => setTab(to))` runs now when it is safe, or after the user has agreed to lose their changes. */
export function useLeaveCheck(): (go: () => void) => void {
  return useContext(DirtyContext)?.leave ?? NO_GUARD;
}
