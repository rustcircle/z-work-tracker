// One horizontal axis: a stretch of real time drawn in proportion, with hour ticks on a zone's
// wall clock, shift bands, zone-change markers, optional client working hours and the logged blocks.
import { useMemo, useState, type ReactNode } from 'react';

import { readableText } from '../../lib/color';
import type { ShiftWindow } from '../../lib/shifts';
import { dayOf, shiftText, type OffsetChange } from '../../lib/tz';
import type { Project } from '../../lib/types';
import { shortDay } from '../../components/format';
import { assignLanes, axisTicks } from './axisGeometry';
import type { Block, Window } from './model';

const LANE = 28;
const BAND_ROW = 18;

export interface AxisProps {
  start: number;
  end: number;
  zone: string;
  /** Short name of the axis for assistive technology, such as "Lisbon time". */
  name: string;
  blocks: readonly Block[];
  lanes: number;
  windows: readonly ShiftWindow[];
  markers: readonly OffsetChange[];
  work?: readonly Window[];
  workLabel?: string;
  nowSec?: number;
  projects: ReadonlyMap<string, Project>;
  /** Primary axes carry names, tooltips and focusable blocks; the second axis repeats them quietly. */
  interactive: boolean;
  labelOf?: (b: Block) => string;
  tipOf?: (b: Block) => ReactNode;
  windowTitle?: (w: ShiftWindow) => string;
  /** The date the card is for. A different date at the axis's left edge is printed there. */
  refDay?: string;
}

function BlockView({ block, project, left, width, labelOf, tipOf, interactive }: { block: Block; project: Project | undefined; left: number; width: number; labelOf?: (b: Block) => string; tipOf?: (b: Block) => ReactNode; interactive: boolean }) {
  const [tip, setTip] = useState(false);
  const color = project?.color ?? '#6b7280';
  const label = labelOf?.(block);
  return (
    <div
      className={`block ${block.live ? 'block-live' : ''}`}
      data-testid={interactive ? 'block' : undefined}
      data-project={block.projectId}
      data-live={block.live ? 'true' : undefined}
      style={{ left: `${left}%`, width: `${width}%`, top: block.lane * LANE + 4, height: LANE - 4, backgroundColor: color, color: readableText(color) }}
      tabIndex={interactive ? 0 : undefined}
      role={interactive ? 'img' : undefined}
      aria-label={interactive ? label : undefined}
      aria-hidden={interactive ? undefined : true}
      onMouseEnter={interactive ? () => setTip(true) : undefined}
      onMouseLeave={interactive ? () => setTip(false) : undefined}
      onFocus={interactive ? () => setTip(true) : undefined}
      onBlur={interactive ? () => setTip(false) : undefined}
    >
      {interactive && width > 7 && <span className="block-text">{label?.split(',')[0]}</span>}
      {interactive && tip && tipOf && (
        <div className={`tip ${left + width / 2 > 55 ? 'tip-right' : ''}`} role="tooltip" aria-hidden="true">
          {tipOf(block)}
        </div>
      )}
    </div>
  );
}

export function Axis(p: AxisProps) {
  const { start, end, zone } = p;
  const length = end - start;
  const ticks = useMemo(() => axisTicks(start, end, zone), [start, end, zone]);
  const bandLanes = useMemo(() => assignLanes(p.windows), [p.windows]);
  const pct = (t: number): number => (Math.min(Math.max(t, start), end) - start) / length * 100;
  const bandRows = p.windows.length > 0 ? bandLanes.count : 0;
  const stripH = bandRows * BAND_ROW;
  const trackH = stripH + Math.max(1, p.lanes) * LANE + 8;
  const edgeDate = p.refDay !== undefined && dayOf(start, zone) !== p.refDay;
  const now = p.nowSec !== undefined && p.nowSec > start && p.nowSec < end ? p.nowSec : null;

  return (
    <div className="axis" role="group" aria-label={`${p.name} axis`}>
      <div className="axis-track" style={{ height: trackH }}>
        {p.windows.map((w, i) => (
          <div key={`${w.versionId}${w.start}`} className="shift-band" data-testid="shift-band" style={{ left: `${pct(w.start)}%`, width: `${pct(w.end) - pct(w.start)}%` }} title={p.windowTitle?.(w) ?? w.name}>
            <span className="shift-band-bar" style={{ background: w.color, top: (bandLanes.lanes[i] ?? 0) * BAND_ROW }} />
            <span className="shift-band-label" style={{ top: (bandLanes.lanes[i] ?? 0) * BAND_ROW + 3 }}>
              {w.name}
            </span>
          </div>
        ))}
        {p.work?.map((w) => (
          <div key={`w${w.start}`} className="work-window" style={{ left: `${pct(w.start)}%`, width: `${pct(w.end) - pct(w.start)}%` }} title={p.workLabel} data-testid="work-window" />
        ))}
        {ticks.map((t) => (
          <span key={t.at} className={`grid-line ${t.major ? 'major' : ''} ${t.midnight && t.frac > 0 ? 'midnight' : ''}`} style={{ left: `${t.frac * 100}%` }} />
        ))}
        {p.markers.map((m) => (
          <span key={m.at} className="zone-marker" data-testid="zone-marker" style={{ left: `${pct(m.at)}%` }} title={shiftText(m)}>
            <span className="zone-marker-flag" aria-hidden="true">◆</span>
          </span>
        ))}
        <div className="blocks" style={{ top: stripH }}>
          {p.blocks.map((b) => (
            <BlockView key={b.key} block={b} project={p.projects.get(b.projectId)} left={pct(b.start)} width={Math.max(0.25, pct(b.end) - pct(b.start))} labelOf={p.labelOf} tipOf={p.tipOf} interactive={p.interactive} />
          ))}
        </div>
        {now !== null && <span className="now-line" style={{ left: `${pct(now)}%` }} title="Now" />}
      </div>
      <div className="axis-labels" aria-hidden="true">
        {edgeDate && (
          <span className="axis-label date edge" style={{ left: 0 }}>
            {shortDay(dayOf(start, zone))}
          </span>
        )}
        {ticks
          .filter((t) => (t.major || (t.midnight && t.frac > 0)) && !(edgeDate && t.frac < 0.08 && !t.midnight))
          .map((t) => (
            <span key={t.at} className={`axis-label ${t.repeated ? 'repeated' : ''} ${t.midnight && t.frac > 0 ? 'date' : ''}`} style={{ left: `${t.frac * 100}%` }}>
              {t.midnight && t.frac > 0 ? shortDay(t.day) : t.label}
            </span>
          ))}
      </div>
    </div>
  );
}
