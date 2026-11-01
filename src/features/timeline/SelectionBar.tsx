import type { KeyboardEvent } from 'react';

import type { Numerators } from '../../lib/billing';
import { IconCheck, IconDownload } from '../../components/icons';
import { amountText, formatDuration } from '../../components/format';
import { Button } from '../../components/ui';

export interface SelectionTotals {
  billableSecs: number;
  billable: Numerators;
}

/**
 * Sticks to the bottom of the Timeline while something is selected: how many, the Billable total (the same
 * rounded figures as the rows, masked while earnings are hidden), and the two things to do with it.
 */
export function SelectionBar({ count, hidden, totals, hide, onExport, onClear, onKeyDown }: { count: number; hidden: number; totals: SelectionTotals; hide: boolean; onExport: () => void; onClear: () => void; onKeyDown?: (e: KeyboardEvent<HTMLElement>) => void }) {
  const money = amountText(totals.billable, hide);
  return (
    <section className="selection-bar" aria-label="Selection" data-testid="selection-bar" onKeyDown={onKeyDown}>
      <div className="selection-text">
        <strong data-testid="selection-count">
          <IconCheck /> {count} {count === 1 ? 'task' : 'tasks'} selected
        </strong>
        <span className="selection-total tabular" data-testid="selection-total">
          Total Billable {formatDuration(totals.billableSecs)}
          {money && ` · ${money}`}
        </span>
        <span className="muted selection-note">
          A task counts once for each day it has time on.
          {hidden > 0 && ` ${hidden} of them ${hidden === 1 ? 'is' : 'are'} not on screen now: hidden by the filter, or on a day not shown yet.`}
        </span>
      </div>
      <div className="selection-actions">
        <Button variant="primary" icon={<IconDownload />} onClick={onExport}>
          Export selected
        </Button>
        <Button onClick={onClear}>Clear</Button>
      </div>
    </section>
  );
}
