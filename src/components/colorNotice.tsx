// "Your colour was already taken": the backend swaps an exact clash for a random distinct colour and
// says so. The notice stays on screen until it is dismissed or the colour is chosen again, so a
// replacement is never silent. Held above the tabs, so it survives the form closing.
import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';

import { IconClose, IconInfo } from './icons';
import { useOptionalNav } from './nav';
import { Button } from './ui';

export interface ColorNotice {
  kind: 'project' | 'tag';
  itemId: string;
  name: string;
  /** The colour that was asked for. */
  asked: string;
  /** The colour the item got. */
  got: string;
}

interface Api {
  notices: readonly ColorNotice[];
  report: (n: ColorNotice) => void;
  dismissFor: (kind: ColorNotice['kind'], itemId: string) => void;
}

const NONE: Api = { notices: [], report: () => undefined, dismissFor: () => undefined };
const Ctx = createContext<Api>(NONE);

export function ColorNoticeProvider({ children }: { children: ReactNode }) {
  const [notices, setNotices] = useState<readonly ColorNotice[]>([]);
  const report = useCallback((n: ColorNotice) => setNotices((all) => [...all.filter((x) => !(x.kind === n.kind && x.itemId === n.itemId)), n]), []);
  const dismissFor = useCallback((kind: ColorNotice['kind'], itemId: string) => setNotices((all) => (all.some((x) => x.kind === kind && x.itemId === itemId) ? all.filter((x) => !(x.kind === kind && x.itemId === itemId)) : all)), []);
  const value = useMemo(() => ({ notices, report, dismissFor }), [notices, report, dismissFor]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export const useColorNotices = (): Api => useContext(Ctx);

/** One line per replaced colour: both hex codes are printed, so the swatches are never the only signal. */
export function ColorNoticeBar() {
  const { notices, dismissFor } = useColorNotices();
  const nav = useOptionalNav();
  return (
    <>
      {notices.map((n) => (
        <div key={`${n.kind}:${n.itemId}`} className="banner banner-info color-notice" role="status" data-testid="color-notice">
          <IconInfo />
          <span>
            <strong>{n.name}</strong> was saved with a different colour. Another {n.kind} already used{' '}
            <span className="color-chip"><span className="color-dot" style={{ background: n.asked }} aria-hidden="true" /> <code>{n.asked}</code></span>, so it got{' '}
            <span className="color-chip"><span className="color-dot" style={{ background: n.got }} aria-hidden="true" /> <code>{n.got}</code></span>.
          </span>
          <Button small onClick={() => nav?.chooseColor(n.kind, n.itemId)}>
            Choose again<span className="visually-hidden"> colour for {n.name}</span>
          </Button>
          <button type="button" className="icon-btn" aria-label={`Keep the new colour for ${n.name}`} onClick={() => dismissFor(n.kind, n.itemId)}>
            <IconClose />
          </button>
        </div>
      ))}
    </>
  );
}
