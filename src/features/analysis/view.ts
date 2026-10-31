// The view the Analysis tab last showed, so the Excel analytics sheets match the screen.
import type { Filters } from './engine';
import type { Basis } from './mctx';
import type { RangeSpec } from './range';

export interface AnalysisView {
  range: RangeSpec;
  filters: Filters;
  basis: Basis;
  compare: boolean;
}

let current: AnalysisView | null = null;

export function publishAnalysisView(view: AnalysisView | null): void {
  current = view;
}

export const publishedAnalysisView = (): AnalysisView | null => current;
