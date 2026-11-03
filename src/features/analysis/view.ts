// The view the Analysis tab is showing right now, so the Excel analytics sheets match the screen. The tab takes
// it back when it goes, so a filter applies to an export only while it can be seen.
import { useSyncExternalStore } from 'react';

import type { Filters } from './engine';
import type { Basis } from './mctx';
import type { RangeSpec } from './range';

export interface AnalysisView {
  range: RangeSpec;
  /** What the figures are worked out with: the filters as chosen, with the name search turned into task ids. */
  filters: Filters;
  /** The filters as chosen on screen, for saying in words what applies. When missing, `filters` says it. */
  shown?: Filters;
  basis: Basis;
  compare: boolean;
}

let current: AnalysisView | null = null;
const listeners = new Set<() => void>();

export function publishAnalysisView(view: AnalysisView | null): void {
  current = view;
  for (const listener of listeners) listener();
}

export const publishedAnalysisView = (): AnalysisView | null => current;

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** The published view, and a new render whenever it changes or is taken back. */
export const useAnalysisView = (): AnalysisView | null => useSyncExternalStore(subscribe, publishedAnalysisView, publishedAnalysisView);
