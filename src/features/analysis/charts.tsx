// Small hand-written SVG chart primitives. Nothing here injects styles: colours and patterns come
// from classes in analysis.css (theme variables), so every chart follows the active theme and the
// bundle stays CSP clean. Project marks use the project's exact colour; marks for concepts that
// belong to no project use one vivid colour plus one pattern per concept, in every chart.
import { useEffect, useId, useLayoutEffect, useState, type KeyboardEvent, type PointerEvent, type ReactNode } from 'react';

import { readableText } from '../../lib/color';

export type Concept = 'worked' | 'paused' | 'target' | 'previous' | 'outside';
export const CONCEPT_LABEL: Record<Concept, string> = {
  worked: 'Worked',
  paused: 'Paused',
  target: 'Target',
  previous: 'Previous period',
  outside: 'Outside any shift',
};

/** Marks thinner than this fall back to the solid vivid colour: a pattern would only shimmer. */
const SOLID_BELOW = 7;

/** Defines the five concept patterns once; every chart references them by id. */
export function PatternDefs() {
  return (
    <svg className="a-defs" width="0" height="0" aria-hidden="true" focusable="false">
      <defs>
        <pattern id="pat-worked" width="8" height="8" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
          <rect width="8" height="8" className="pf-bg-worked" />
          <rect width="3.6" height="8" className="pf-worked" />
        </pattern>
        <pattern id="pat-paused" width="9" height="9" patternUnits="userSpaceOnUse">
          <rect width="9" height="9" className="pf-bg-paused" />
          <circle cx="4.5" cy="4.5" r="2.1" className="pf-paused" />
        </pattern>
        <pattern id="pat-target" width="8" height="8" patternUnits="userSpaceOnUse">
          <rect width="8" height="8" className="pf-bg-target" />
          <path d="M0 0L8 8M8 0L0 8" className="pk-target" />
        </pattern>
        <pattern id="pat-previous" width="9" height="9" patternUnits="userSpaceOnUse">
          <rect width="9" height="9" className="pf-bg-previous" />
          <path d="M0.5 6.8L4.5 2.4L8.5 6.8" className="pk-previous" />
        </pattern>
        <pattern id="pat-outside" width="8" height="6" patternUnits="userSpaceOnUse">
          <rect width="8" height="6" className="pf-bg-outside" />
          <rect y="0" width="8" height="2.4" className="pf-outside" />
        </pattern>
      </defs>
    </svg>
  );
}

interface FillProps {
  fill?: string;
  className?: string;
}

/** Fill for a mark: a project colour, or a concept's pattern (solid when the mark is tiny). */
export function markFill(seg: { fill?: string; concept?: Concept }, w: number, h: number): FillProps {
  if (seg.concept) return Math.min(w, h) < SOLID_BELOW ? { className: `fill-${seg.concept}` } : { fill: `url(#pat-${seg.concept})` };
  return { fill: seg.fill ?? 'var(--accent)' };
}

/** A legend swatch drawn with the same pattern as the marks. */
export function Swatch({ concept, color }: { concept?: Concept; color?: string }) {
  return (
    <svg className="a-swatch" width="18" height="12" viewBox="0 0 18 12" aria-hidden="true">
      <rect width="18" height="12" rx="2" {...(concept ? { fill: `url(#pat-${concept})` } : { fill: color })} className="a-swatch-box" />
    </svg>
  );
}

export interface LegendEntry {
  key: string;
  label: string;
  concept?: Concept;
  color?: string;
}

export function Legend({ items }: { items: readonly LegendEntry[] }) {
  if (items.length === 0) return null;
  return (
    <ul className="a-legend" aria-label="Legend">
      {items.map((it) => (
        <li key={it.key}>
          <Swatch {...(it.concept ? { concept: it.concept } : {})} {...(it.color ? { color: it.color } : {})} />
          <span>{it.label}</span>
        </li>
      ))}
    </ul>
  );
}

// ------------------------------------------------------------------ frame, size and tooltip

export interface TipApi {
  show: (e: PointerEvent | { currentTarget: Element }, lines: readonly string[]) => void;
  hide: () => void;
}

function useWidth(el: HTMLElement | null): number {
  const [w, setW] = useState(0);
  useLayoutEffect(() => {
    if (!el) return;
    const measure = (): void => setW(Math.floor(el.clientWidth) || 640);
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [el]);
  return w;
}

export function ChartBox({ children, className = '' }: { children: (width: number, tip: TipApi) => ReactNode; className?: string }) {
  const [box, setBox] = useState<HTMLDivElement | null>(null);
  const width = useWidth(box);
  const [tip, setTip] = useState<{ x: number; y: number; lines: readonly string[] } | null>(null);
  const api: TipApi = {
    show: (e, lines) => {
      const rect = box?.getBoundingClientRect();
      if (!rect) return;
      if ('clientX' in e) setTip({ x: e.clientX - rect.left, y: e.clientY - rect.top, lines });
      else {
        const r = e.currentTarget.getBoundingClientRect();
        setTip({ x: r.left + r.width / 2 - rect.left, y: r.top - rect.top, lines });
      }
    },
    hide: () => setTip(null),
  };
  return (
    <div ref={setBox} className={`a-chart ${className}`} onPointerLeave={api.hide}>
      {width > 0 ? children(width, api) : null}
      {tip ? (
        <div className={`a-tip ${tip.x > width * 0.62 ? 'a-tip-left' : ''}`} role="tooltip" style={{ left: tip.x, top: tip.y }}>
          {tip.lines.map((l, i) => (
            <div key={i} className={i === 0 ? 'a-tip-head' : ''}>
              {l}
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

export function EmptyChart({ message }: { message: string }) {
  return (
    <div className="a-empty" role="status">
      {message}
    </div>
  );
}

// ------------------------------------------------------------------ axes

const LADDER = [600, 900, 1800, 3600, 7200, 10800, 14400, 21600, 28800, 43200, 86400, 172800, 604800, 1209600, 2419200];

export interface Scale {
  top: number;
  ticks: number[];
  format: (v: number) => string;
}

/** A time axis in seconds with round steps, labelled in hours. */
export function timeScale(max: number): Scale {
  const m = Math.max(max, 600);
  const step = LADDER.find((s) => m / s <= 5) ?? (LADDER[LADDER.length - 1] as number);
  const top = Math.ceil(m / step) * step;
  const ticks: number[] = [];
  for (let v = 0; v <= top + 1; v += step) ticks.push(v);
  const format = (v: number): string => (step % 3600 === 0 ? `${v / 3600}h` : `${Math.floor(v / 3600)}:${String(Math.round((v % 3600) / 60)).padStart(2, '0')}`);
  return { top, ticks, format };
}

export function countScale(max: number, unit = ''): Scale {
  const m = Math.max(max, 1);
  const raw = m / 4;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((k) => k * mag).find((s) => s >= raw) ?? mag * 10;
  const top = Math.ceil(m / step) * step;
  const ticks: number[] = [];
  for (let v = 0; v <= top + step / 2; v += step) ticks.push(Math.round(v * 1000) / 1000);
  return { top, ticks, format: (v) => `${v}${unit}` };
}

export function percentScale(max = 1): Scale {
  const top = max <= 1 ? 1 : Math.ceil(max * 4) / 4;
  const ticks = [0, top / 4, top / 2, (3 * top) / 4, top];
  return { top, ticks, format: (v) => `${Math.round(v * 100)}%` };
}

const M = { left: 46, right: 10, top: 18, bottom: 28 };

function YAxis({ scale, h, w, title }: { scale: Scale; h: number; w: number; title: string }) {
  const y = (v: number): number => M.top + h - (v / scale.top) * h;
  return (
    <g className="a-axis">
      <text x={4} y={11} className="a-axis-title">
        {title}
      </text>
      {scale.ticks.map((t) => (
        <g key={t}>
          <line x1={M.left} x2={M.left + w} y1={y(t)} y2={y(t)} className={t === 0 ? 'a-axis-line' : 'a-grid'} />
          <text x={M.left - 6} y={y(t) + 4} textAnchor="end" className="a-axis-text">
            {scale.format(t)}
          </text>
        </g>
      ))}
    </g>
  );
}

function XLabels({ labels, slot, y, left = M.left }: { labels: readonly string[]; slot: number; y: number; left?: number }) {
  const widest = Math.max(1, ...labels.map((l) => l.length));
  const every = Math.max(1, Math.ceil((widest * 6.6 + 6) / slot));
  return (
    <g className="a-axis">
      {labels.map((l, i) =>
        i % every === 0 ? (
          <text key={i} x={left + slot * i + slot / 2} y={y} textAnchor="middle" className="a-axis-text">
            {l}
          </text>
        ) : null,
      )}
    </g>
  );
}

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

// ------------------------------------------------------------------ stacked and grouped columns

export interface Seg {
  id: string;
  label: string;
  value: number;
  /** Project colour. */
  fill?: string;
  /** Concept pattern when the mark belongs to no project. */
  concept?: Concept;
  /** Text shown for the value in tooltips. */
  text?: string;
}

export interface Col {
  key: string;
  label: string;
  segs: Seg[];
  tip: string[];
}

export interface LineOverlay {
  id: string;
  concept: Concept;
  label: string;
  values: (number | null)[];
}

export interface ColumnMarker {
  index: number;
  text: string;
}

export function onActivate(fn: () => void): { onClick: () => void; onKeyDown: (e: KeyboardEvent) => void; tabIndex: 0; role: 'button' } {
  return {
    onClick: fn,
    onKeyDown: (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        fn();
      }
    },
    tabIndex: 0,
    role: 'button',
  };
}

export interface ColumnsProps {
  cols: readonly Col[];
  scale: Scale;
  yTitle: string;
  ariaLabel: string;
  layout?: 'stack' | 'group';
  height?: number;
  lines?: readonly LineOverlay[];
  markers?: readonly ColumnMarker[];
  onSelect?: (col: Col, index: number) => void;
  empty?: string;
}

export function Columns({ cols, scale, yTitle, ariaLabel, layout = 'stack', height = 230, lines = [], markers = [], onSelect, empty }: ColumnsProps) {
  const anyValue = cols.some((c) => c.segs.some((s) => s.value > 0));
  if (!anyValue && empty) return <EmptyChart message={empty} />;
  return (
    <ChartBox>
      {(width, tip) => {
        const w = width - M.left - M.right;
        const h = height - M.top - M.bottom;
        const slot = w / Math.max(1, cols.length);
        const bw = clamp(slot * 0.72, 3, 64);
        const y = (v: number): number => M.top + h - (v / scale.top) * h;
        return (
          <svg width={width} height={height} role="img" aria-label={ariaLabel} className="a-svg">
            <YAxis scale={scale} h={h} w={w} title={yTitle} />
            {cols.map((c, i) => {
              const cx = M.left + slot * i + slot / 2;
              let acc = 0;
              const n = Math.max(1, c.segs.length);
              const gw = bw / n;
              const marks = c.segs.map((s, k) => {
                const hh = (s.value / scale.top) * h;
                const top = layout === 'stack' ? y(acc + s.value) : y(s.value);
                const x = layout === 'stack' ? cx - bw / 2 : cx - bw / 2 + k * gw;
                const ww = layout === 'stack' ? bw : Math.max(2, gw - 1);
                acc += s.value;
                if (hh < 0.4) return null;
                return <rect key={s.id} x={x} y={top} width={ww} height={hh} rx={1} {...markFill(s, ww, hh)} className={`a-mark ${markFill(s, ww, hh).className ?? ''}`} />;
              });
              const handlers = {
                onPointerMove: (e: PointerEvent) => tip.show(e, c.tip),
                onFocus: (e: { currentTarget: Element }) => tip.show(e, c.tip),
                onBlur: tip.hide,
              };
              return (
                <g key={c.key} aria-label={`${c.label}: ${c.tip.slice(1).join(', ')}`} {...handlers} {...(onSelect ? onActivate(() => onSelect(c, i)) : {})} className={onSelect ? 'a-hit' : ''}>
                  <rect x={M.left + slot * i} y={M.top} width={slot} height={h} className="a-hover-area" />
                  {marks}
                </g>
              );
            })}
            {lines.map((ln) => (
              <LinePath key={ln.id} values={ln.values} concept={ln.concept} x={(i) => M.left + slot * i + slot / 2} y={y} />
            ))}
            {markers.map((m) => (
              <g key={`${m.index}-${m.text}`} {...{ onPointerMove: (e: PointerEvent) => tip.show(e, ['Clock change', m.text]) }}>
                <line x1={M.left + slot * m.index + slot / 2} x2={M.left + slot * m.index + slot / 2} y1={M.top} y2={M.top + h} className="a-marker-line" />
                <path d={`M${M.left + slot * m.index + slot / 2 - 5} ${M.top - 7}l5 7l5 -7z`} className="a-marker-flag">
                  <title>{m.text}</title>
                </path>
              </g>
            ))}
            <XLabels labels={cols.map((c) => c.label)} slot={slot} y={height - 8} />
          </svg>
        );
      }}
    </ChartBox>
  );
}

/** A line in a concept's colour: a solid 2px stroke over a patterned ribbon. */
function LinePath({ values, concept, x, y }: { values: readonly (number | null)[]; concept: Concept; x: (i: number) => number; y: (v: number) => number }) {
  let d = '';
  let pen = false;
  values.forEach((v, i) => {
    if (v === null) {
      pen = false;
      return;
    }
    d += `${pen ? 'L' : 'M'}${x(i).toFixed(1)} ${y(v).toFixed(1)}`;
    pen = true;
  });
  if (!d) return null;
  return (
    <g>
      <path d={d} fill="none" stroke={`url(#pat-${concept})`} strokeWidth={7} strokeLinejoin="round" strokeLinecap="round" className="a-ribbon" />
      <path d={d} fill="none" strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" className={`stroke-${concept}`} />
    </g>
  );
}

// ------------------------------------------------------------------ line chart

export interface LineSeries {
  id: string;
  concept?: Concept;
  color?: string;
  label: string;
  values: (number | null)[];
}

export function LineChart({ xLabels, series, scale, yTitle, ariaLabel, height = 190, tipFor, empty }: { xLabels: readonly string[]; series: readonly LineSeries[]; scale: Scale; yTitle: string; ariaLabel: string; height?: number; tipFor: (i: number) => string[]; empty?: string }) {
  if (empty && !series.some((s) => s.values.some((v) => v !== null))) return <EmptyChart message={empty} />;
  return (
    <ChartBox>
      {(width, tip) => {
        const w = width - M.left - M.right;
        const h = height - M.top - M.bottom;
        const slot = w / Math.max(1, xLabels.length);
        const y = (v: number): number => M.top + h - (clamp(v, 0, scale.top) / scale.top) * h;
        const x = (i: number): number => M.left + slot * i + slot / 2;
        return (
          <svg width={width} height={height} role="img" aria-label={ariaLabel} className="a-svg">
            <YAxis scale={scale} h={h} w={w} title={yTitle} />
            {series.map((s) =>
              s.concept ? (
                <LinePath key={s.id} values={s.values} concept={s.concept} x={x} y={y} />
              ) : (
                <path key={s.id} d={pathOf(s.values, x, y)} fill="none" stroke={s.color} strokeWidth={2} />
              ),
            )}
            {series.map((s) =>
              xLabels.length <= 45
                ? s.values.map((v, i) => (v === null ? null : <circle key={`${s.id}-${i}`} cx={x(i)} cy={y(v)} r={2.6} className={s.concept ? `fill-${s.concept} a-dot` : 'a-dot'} {...(s.color ? { fill: s.color } : {})} />))
                : null,
            )}
            {xLabels.map((_, i) => (
              <rect key={i} x={M.left + slot * i} y={M.top} width={slot} height={h} className="a-hover-area" onPointerMove={(e) => tip.show(e, tipFor(i))} />
            ))}
            <XLabels labels={xLabels} slot={slot} y={height - 8} />
          </svg>
        );
      }}
    </ChartBox>
  );
}

function pathOf(values: readonly (number | null)[], x: (i: number) => number, y: (v: number) => number): string {
  let d = '';
  let pen = false;
  values.forEach((v, i) => {
    if (v === null) {
      pen = false;
      return;
    }
    d += `${pen ? 'L' : 'M'}${x(i).toFixed(1)} ${y(v).toFixed(1)}`;
    pen = true;
  });
  return d;
}

// ------------------------------------------------------------------ stacked area

export function StackedArea({ xLabels, series, scale, yTitle, ariaLabel, tipFor, height = 220, empty }: { xLabels: readonly string[]; series: readonly { id: string; color: string; values: number[] }[]; scale: Scale; yTitle: string; ariaLabel: string; tipFor: (i: number) => string[]; height?: number; empty?: string }) {
  if (empty && !series.some((s) => s.values.some((v) => v > 0))) return <EmptyChart message={empty} />;
  return (
    <ChartBox>
      {(width, tip) => {
        const w = width - M.left - M.right;
        const h = height - M.top - M.bottom;
        const n = xLabels.length;
        const slot = w / Math.max(1, n);
        const x = (i: number): number => (n <= 1 ? M.left + w / 2 : M.left + slot / 2 + ((w - slot) * i) / (n - 1));
        const y = (v: number): number => M.top + h - (clamp(v, 0, scale.top) / scale.top) * h;
        const base = new Array<number>(n).fill(0);
        const layers = series.map((s) => {
          const lower = [...base];
          const upper = s.values.map((v, i) => (base[i] = (base[i] as number) + v));
          const top = upper.map((v, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)} ${y(v).toFixed(1)}`).join('');
          const bottom = lower
            .map((v, i) => `L${x(i).toFixed(1)} ${y(v).toFixed(1)}`)
            .reverse()
            .join('');
          return { id: s.id, color: s.color, d: `${top}${bottom}Z` };
        });
        return (
          <svg width={width} height={height} role="img" aria-label={ariaLabel} className="a-svg">
            <YAxis scale={scale} h={h} w={w} title={yTitle} />
            {layers.map((l) => (
              <path key={l.id} d={l.d} fill={l.color} className="a-area" />
            ))}
            {xLabels.map((_, i) => (
              <rect key={i} x={x(i) - slot / 2} y={M.top} width={slot} height={h} className="a-hover-area" onPointerMove={(e) => tip.show(e, tipFor(i))} />
            ))}
            <XLabels labels={xLabels} slot={slot} y={height - 8} />
          </svg>
        );
      }}
    </ChartBox>
  );
}

// ------------------------------------------------------------------ horizontal bars

export interface HRow {
  key: string;
  label: string;
  /** Total length of the bar. */
  value: number;
  valueText: string;
  segs?: Seg[];
  fill?: string;
  concept?: Concept;
  tip: string[];
  /** A thin marker (for example the previous period) at this value. */
  mark?: number | null;
  onSelect?: () => void;
}

export function HBars({ rows, max, ariaLabel, empty }: { rows: readonly HRow[]; max?: number; ariaLabel: string; empty?: string }) {
  if (empty && rows.every((r) => r.value <= 0)) return <EmptyChart message={empty} />;
  const top = max ?? Math.max(1, ...rows.map((r) => Math.max(r.value, r.mark ?? 0)));
  return (
    <ChartBox>
      {(width, tip) => {
        const rh = 28;
        const labelW = clamp(width * 0.3, 96, 190);
        const valueW = 74;
        const bw = Math.max(20, width - labelW - valueW - 12);
        const height = rows.length * rh + 6;
        return (
          <svg width={width} height={height} role="img" aria-label={ariaLabel} className="a-svg">
            {rows.map((r, i) => {
              const y = i * rh + 3;
              const len = (r.value / top) * bw;
              const handlers = { onPointerMove: (e: PointerEvent) => tip.show(e, r.tip), onFocus: (e: { currentTarget: Element }) => tip.show(e, r.tip), onBlur: tip.hide };
              let acc = 0;
              return (
                <g key={r.key} {...handlers} {...(r.onSelect ? onActivate(r.onSelect) : {})} aria-label={`${r.label}: ${r.valueText}`} className={r.onSelect ? 'a-hit' : ''}>
                  <rect x={0} y={y - 2} width={width} height={rh - 2} className="a-hover-area" />
                  <text x={labelW - 8} y={y + 15} textAnchor="end" className="a-label">
                    {r.label.length > 24 ? `${r.label.slice(0, 23)}…` : r.label}
                    <title>{r.label}</title>
                  </text>
                  {r.segs ? (
                    r.segs.map((s) => {
                      const sl = (s.value / top) * bw;
                      const x = labelW + acc;
                      acc += sl;
                      return sl < 0.4 ? null : <rect key={s.id} x={x} y={y} width={sl} height={rh - 8} rx={1} {...markFill(s, sl, rh - 8)} className={`a-mark ${markFill(s, sl, rh - 8).className ?? ''}`} />;
                    })
                  ) : (
                    <rect x={labelW} y={y} width={Math.max(0, len)} height={rh - 8} rx={2} {...markFill({ ...(r.fill ? { fill: r.fill } : {}), ...(r.concept ? { concept: r.concept } : {}) }, len, rh - 8)} className={`a-mark ${markFill({ ...(r.concept ? { concept: r.concept } : {}) }, len, rh - 8).className ?? ''}`} />
                  )}
                  {r.mark != null ? <line x1={labelW + (r.mark / top) * bw} x2={labelW + (r.mark / top) * bw} y1={y - 2} y2={y + rh - 6} className="a-prev-tick" /> : null}
                  <text x={labelW + len + 6} y={y + 15} className="a-value">
                    {r.valueText}
                  </text>
                </g>
              );
            })}
          </svg>
        );
      }}
    </ChartBox>
  );
}

// ------------------------------------------------------------------ donut with direct labels

export interface Slice {
  key: string;
  label: string;
  value: number;
  color: string;
  tip: string[];
  onSelect?: () => void;
}

export function Donut({ slices, centerTop, centerBottom, ariaLabel, empty }: { slices: readonly Slice[]; centerTop: string; centerBottom: string; ariaLabel: string; empty?: string }) {
  const total = slices.reduce((n, s) => n + s.value, 0);
  if (total <= 0) return empty ? <EmptyChart message={empty} /> : null;
  return (
    <ChartBox>
      {(width, tip) => {
        const size = clamp(width, 260, 460);
        const height = Math.min(size, 330);
        const cx = width / 2;
        const cy = height / 2;
        const ro = Math.min(height / 2 - 34, width / 2 - 130);
        const R = Math.max(54, ro);
        const r = R * 0.6;
        let a0 = -Math.PI / 2;
        const labels: { key: string; x: number; y: number; right: boolean; text: string; lx: number; ly: number }[] = [];
        const arcs = slices.map((s) => {
          const frac = s.value / total;
          const a1 = a0 + frac * Math.PI * 2;
          const large = a1 - a0 > Math.PI ? 1 : 0;
          const p = (rad: number, a: number): string => `${(cx + rad * Math.cos(a)).toFixed(1)} ${(cy + rad * Math.sin(a)).toFixed(1)}`;
          const d = frac >= 0.9999 ? `M${p(R, a0)}A${R} ${R} 0 1 1 ${p(R, a0 + Math.PI)}A${R} ${R} 0 1 1 ${p(R, a0)}ZM${p(r, a0)}A${r} ${r} 0 1 0 ${p(r, a0 + Math.PI)}A${r} ${r} 0 1 0 ${p(r, a0)}Z` : `M${p(R, a0)}A${R} ${R} 0 ${large} 1 ${p(R, a1)}L${p(r, a1)}A${r} ${r} 0 ${large} 0 ${p(r, a0)}Z`;
          const mid = (a0 + a1) / 2;
          if (frac >= 0.035) {
            const right = Math.cos(mid) >= 0;
            labels.push({ key: s.key, x: cx + (R + 14) * Math.cos(mid), y: cy + (R + 14) * Math.sin(mid), right, text: `${s.label.length > 18 ? `${s.label.slice(0, 17)}…` : s.label} ${Math.round(frac * 100)}%`, lx: cx + (R + 2) * Math.cos(mid), ly: cy + (R + 2) * Math.sin(mid) });
          }
          a0 = a1;
          return { s, d };
        });
        // Push labels apart on each side so they never overlap.
        for (const side of [true, false]) {
          const group = labels.filter((l) => l.right === side).sort((a, b) => a.y - b.y);
          for (let i = 1; i < group.length; i += 1) {
            const prev = group[i - 1] as (typeof group)[number];
            const cur = group[i] as (typeof group)[number];
            if (cur.y - prev.y < 15) cur.y = prev.y + 15;
          }
        }
        return (
          <svg width={width} height={height} role="img" aria-label={ariaLabel} className="a-svg">
            {arcs.map(({ s, d }) => (
              <path key={s.key} d={d} fill={s.color} fillRule="evenodd" className={`a-slice ${s.onSelect ? 'a-hit' : ''}`} onPointerMove={(e) => tip.show(e, s.tip)} {...(s.onSelect ? onActivate(s.onSelect) : {})} aria-label={`${s.label}: ${s.tip.slice(1).join(', ')}`} />
            ))}
            {labels.map((l) => (
              <g key={l.key}>
                <polyline points={`${l.lx},${l.ly} ${l.x},${l.y} ${l.x + (l.right ? 8 : -8)},${l.y}`} fill="none" className="a-leader" />
                <text x={l.x + (l.right ? 11 : -11)} y={l.y + 4} textAnchor={l.right ? 'start' : 'end'} className="a-label">
                  {l.text}
                </text>
              </g>
            ))}
            <text x={cx} y={cy - 2} textAnchor="middle" className="a-donut-total">
              {centerTop}
            </text>
            <text x={cx} y={cy + 16} textAnchor="middle" className="a-axis-text">
              {centerBottom}
            </text>
          </svg>
        );
      }}
    </ChartBox>
  );
}

// ------------------------------------------------------------------ heatmaps

export function heatIndex(v: number, max: number): number {
  if (v <= 0 || max <= 0) return -1;
  return Math.min(5, Math.floor((v / max) * 6));
}

export function HeatLegend({ label }: { label: string }) {
  return (
    <div className="a-heatlegend" aria-label={label}>
      <span>Less</span>
      {[0, 1, 2, 3, 4, 5].map((i) => (
        <svg key={i} width="16" height="12" aria-hidden="true">
          <rect width="16" height="12" rx="2" className={`heat-${i}`} />
        </svg>
      ))}
      <span>More</span>
    </div>
  );
}

export function WeekdayHourHeat({ cells, max, rowLabels, tipFor, ariaLabel, onSelect }: { cells: readonly number[]; max: number; rowLabels: readonly string[]; tipFor: (row: number, hour: number) => string[]; ariaLabel: string; onSelect?: (row: number, hour: number) => void }) {
  return (
    <ChartBox>
      {(width, tip) => {
        const left = 40;
        const top = 18;
        const cw = (width - left - 6) / 24;
        const ch = clamp(cw * 1.1, 14, 26);
        const height = top + ch * rowLabels.length + 6;
        return (
          <svg width={width} height={height} role="img" aria-label={ariaLabel} className="a-svg">
            {Array.from({ length: 24 }, (_, h) =>
              h % 3 === 0 ? (
                <text key={h} x={left + h * cw + cw / 2} y={12} textAnchor="middle" className="a-axis-text">
                  {String(h).padStart(2, '0')}
                </text>
              ) : null,
            )}
            {rowLabels.map((r, row) => (
              <g key={r}>
                <text x={left - 6} y={top + row * ch + ch / 2 + 4} textAnchor="end" className="a-axis-text">
                  {r}
                </text>
                {Array.from({ length: 24 }, (_, h) => {
                  const v = cells[row * 24 + h] as number;
                  const idx = heatIndex(v, max);
                  return (
                    <rect
                      key={h}
                      x={left + h * cw + 0.5}
                      y={top + row * ch + 0.5}
                      width={cw - 1}
                      height={ch - 1}
                      rx={2}
                      className={`${idx < 0 ? 'heat-empty' : `heat-${idx}`} ${onSelect ? 'a-hit' : ''}`}
                      onPointerMove={(e) => tip.show(e, tipFor(row, h))}
                      {...(onSelect ? { onClick: () => onSelect(row, h) } : {})}
                    />
                  );
                })}
              </g>
            ))}
          </svg>
        );
      }}
    </ChartBox>
  );
}

export interface CalDay {
  day: string;
  dayNum: number;
  secs: number;
}

export function CalendarHeat({ days, max, weekdayOf, tipFor, ariaLabel, onSelect }: { days: readonly CalDay[]; max: number; weekdayOf: (n: number) => number; tipFor: (d: CalDay) => string[]; ariaLabel: string; onSelect?: (d: CalDay) => void }) {
  return (
    <ChartBox>
      {(width, tip) => {
        const first = days[0];
        if (!first) return null;
        const lead = weekdayOf(first.dayNum);
        const weeks = Math.ceil((days.length + lead) / 7);
        const left = 30;
        const cell = clamp(Math.floor((width - left - 4) / weeks), 8, 18);
        const height = 18 + cell * 7 + 6;
        const monthLabels: { x: number; t: string }[] = [];
        days.forEach((d, i) => {
          if (d.day.endsWith('-01') || i === 0) {
            const col = Math.floor((i + lead) / 7);
            monthLabels.push({ x: left + col * cell, t: ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][Number(d.day.slice(5, 7)) - 1] as string });
          }
        });
        return (
          <svg width={width} height={height} role="img" aria-label={ariaLabel} className="a-svg">
            {monthLabels.map((m) => (
              <text key={m.x} x={m.x} y={11} className="a-axis-text">
                {m.t}
              </text>
            ))}
            {['Mon', 'Wed', 'Fri'].map((t, i) => (
              <text key={t} x={left - 5} y={18 + cell * (i * 2) + cell - 2} textAnchor="end" className="a-axis-text">
                {t}
              </text>
            ))}
            {days.map((d, i) => {
              const col = Math.floor((i + lead) / 7);
              const row = (i + lead) % 7;
              const idx = heatIndex(d.secs, max);
              return (
                <rect
                  key={d.day}
                  x={left + col * cell + 0.5}
                  y={18 + row * cell + 0.5}
                  width={cell - 1.5}
                  height={cell - 1.5}
                  rx={2}
                  className={`${idx < 0 ? 'heat-empty' : `heat-${idx}`} ${onSelect ? 'a-hit' : ''}`}
                  onPointerMove={(e) => tip.show(e, tipFor(d))}
                  {...(onSelect ? { onClick: () => onSelect(d) } : {})}
                />
              );
            })}
          </svg>
        );
      }}
    </ChartBox>
  );
}

// ------------------------------------------------------------------ typical start and finish

export interface DotColumn {
  key: string;
  label: string;
  starts: number[];
  finishes: number[];
  medianStart: number | null;
  medianFinish: number | null;
  q1Start: number | null;
  q3Start: number | null;
  q1Finish: number | null;
  q3Finish: number | null;
  tip: string[];
}

export function StartFinishPlot({ cols, ariaLabel, fmt }: { cols: readonly DotColumn[]; ariaLabel: string; fmt: (m: number) => string }) {
  const all = cols.flatMap((c) => [...c.starts, ...c.finishes]);
  if (all.length === 0) return <EmptyChart message="No days with logged time in this period." />;
  const lo = Math.max(0, Math.floor((Math.min(...all) - 30) / 60) * 60);
  const hi = Math.ceil((Math.max(...all) + 30) / 60) * 60;
  const scale: Scale = { top: hi - lo, ticks: [], format: () => '' };
  const step = hi - lo > 720 ? 180 : hi - lo > 360 ? 120 : 60;
  for (let v = lo; v <= hi; v += step) scale.ticks.push(v - lo);
  return (
    <ChartBox>
      {(width, tip) => {
        const height = 240;
        const w = width - M.left - M.right;
        const h = height - M.top - M.bottom;
        const slot = w / cols.length;
        const y = (m: number): number => M.top + (clamp(m - lo, 0, hi - lo) / (hi - lo)) * h;
        return (
          <svg width={width} height={height} role="img" aria-label={ariaLabel} className="a-svg">
            <text x={4} y={11} className="a-axis-title">
              clock time
            </text>
            {scale.ticks.map((t) => (
              <g key={t}>
                <line x1={M.left} x2={M.left + w} y1={y(t + lo)} y2={y(t + lo)} className="a-grid" />
                <text x={M.left - 6} y={y(t + lo) + 4} textAnchor="end" className="a-axis-text">
                  {fmt(t + lo)}
                </text>
              </g>
            ))}
            {cols.map((c, i) => {
              const cx = M.left + slot * i + slot / 2;
              const bw = clamp(slot * 0.46, 8, 40);
              return (
                <g key={c.key} onPointerMove={(e) => tip.show(e, c.tip)}>
                  <rect x={M.left + slot * i} y={M.top} width={slot} height={h} className="a-hover-area" />
                  {c.medianStart !== null && c.medianFinish !== null ? <rect x={cx - bw / 2} y={y(c.medianStart)} width={bw} height={Math.max(2, y(c.medianFinish) - y(c.medianStart))} rx={2} fill="url(#pat-worked)" className="a-mark" /> : null}
                  {c.q1Start !== null && c.q3Start !== null ? <line x1={cx} x2={cx} y1={y(c.q1Start)} y2={y(c.q3Start)} className="a-whisker" /> : null}
                  {c.q1Finish !== null && c.q3Finish !== null ? <line x1={cx} x2={cx} y1={y(c.q1Finish)} y2={y(c.q3Finish)} className="a-whisker" /> : null}
                  {c.starts.map((m, k) => (
                    <circle key={`s${k}`} cx={cx - bw / 2 - 5} cy={y(m)} r={3} className="a-dot-start" />
                  ))}
                  {c.finishes.map((m, k) => (
                    <rect key={`f${k}`} x={cx + bw / 2 + 2} y={y(m) - 3} width={6} height={6} className="a-dot-finish" transform={`rotate(45 ${cx + bw / 2 + 5} ${y(m)})`} />
                  ))}
                  <text x={cx} y={height - 8} textAnchor="middle" className="a-axis-text">
                    {c.label}
                  </text>
                </g>
              );
            })}
          </svg>
        );
      }}
    </ChartBox>
  );
}

// ------------------------------------------------------------------ progress bars (goals)

export function Progress({ label, valueText, targetText, fraction, ariaLabel }: { label: string; valueText: string; targetText: string; fraction: number; ariaLabel: string }) {
  const id = useId();
  const f = Math.max(0, fraction);
  const shown = Math.min(1, f);
  return (
    <div className="a-progress" role="group" aria-labelledby={id}>
      <div className="a-progress-head" id={id}>
        <span>{label}</span>
        <span className="tabular">
          {valueText} of {targetText}
        </span>
      </div>
      <svg width="100%" height="22" role="img" aria-label={ariaLabel} className="a-svg a-progress-svg" preserveAspectRatio="none" viewBox="0 0 100 22">
        <rect x="0" y="3" width="100" height="16" rx="3" fill="url(#pat-target)" className="a-mark" />
        <rect x="0" y="3" width={shown * 100} height="16" rx="3" fill="url(#pat-worked)" className="a-mark a-progress-fill" />
        {f > 1 ? <path d="M96 3l4 8l-4 8" className="a-over" fill="none" /> : null}
      </svg>
      <div className="a-progress-foot tabular">{Math.round(f * 100)}% of target{f > 1 ? ' (target exceeded)' : ''}</div>
    </div>
  );
}

// ------------------------------------------------------------------ sparkline

export function Sparkline({ values, color, ariaLabel }: { values: readonly (number | null)[]; color?: string; ariaLabel: string }) {
  const nums = values.filter((v): v is number => v !== null);
  const w = 96;
  const h = 26;
  if (nums.length < 2) return <span className="a-spark-empty" aria-hidden="true" />;
  const max = Math.max(...nums);
  const min = Math.min(...nums, 0);
  const x = (i: number): number => 2 + ((w - 4) * i) / Math.max(1, values.length - 1);
  const y = (v: number): number => h - 3 - ((v - min) / Math.max(1e-9, max - min)) * (h - 6);
  return (
    <svg className="a-spark" width={w} height={h} viewBox={`0 0 ${w} ${h}`} role="img" aria-label={ariaLabel}>
      <path d={pathOf(values, x, y)} fill="none" strokeWidth={1.8} strokeLinejoin="round" strokeLinecap="round" {...(color ? { stroke: color } : {})} className={color ? '' : 'stroke-worked'} />
    </svg>
  );
}

// ------------------------------------------------------------------ burn-up

export interface BurnProps {
  color: string;
  series: readonly { dayNum: number; cum: number }[];
  budget: number;
  finishDay: number | null;
  today: number;
  dayLabel: (n: number) => string;
  ariaLabel: string;
}

export function BurnUp({ color, series, budget, finishDay, today, dayLabel, ariaLabel }: BurnProps) {
  if (series.length === 0) return <EmptyChart message="No time logged on this project yet." />;
  const first = (series[0] as { dayNum: number }).dayNum;
  const lastLogged = (series[series.length - 1] as { dayNum: number; cum: number }).cum;
  const endDay = Math.max(today, finishDay ?? today, first + 1);
  const scale = timeScale(Math.max(budget, lastLogged) * 1.05);
  return (
    <ChartBox>
      {(width, tip) => {
        const height = 220;
        const w = width - M.left - M.right;
        const h = height - M.top - M.bottom;
        const x = (d: number): number => M.left + ((d - first) / (endDay - first)) * w;
        const y = (v: number): number => M.top + h - (clamp(v, 0, scale.top) / scale.top) * h;
        const d = series.map((p, i) => `${i ? 'L' : 'M'}${x(p.dayNum).toFixed(1)} ${y(p.cum).toFixed(1)}`).join('');
        const lastPoint = series[series.length - 1] as { dayNum: number; cum: number };
        const labelDays = [first, Math.round((first + endDay) / 2), endDay];
        return (
          <svg width={width} height={height} role="img" aria-label={ariaLabel} className="a-svg">
            <YAxis scale={scale} h={h} w={w} title="hours" />
            <line x1={M.left} x2={M.left + w} y1={y(budget)} y2={y(budget)} strokeWidth={2} className="stroke-target" />
            <rect x={M.left} y={y(budget) - 3} width={w} height={6} fill="url(#pat-target)" className="a-ribbon" />
            <text x={M.left + w} y={y(budget) - 8} textAnchor="end" className="a-label">
              Budget
            </text>
            <path d={d} fill="none" stroke={color} strokeWidth={2.4} strokeLinejoin="round" />
            {finishDay !== null ? <line x1={x(lastPoint.dayNum)} y1={y(lastPoint.cum)} x2={x(finishDay)} y2={y(budget)} strokeWidth={2} strokeDasharray="5 4" stroke={color} /> : null}
            {finishDay !== null ? <circle cx={x(finishDay)} cy={y(budget)} r={4} fill={color} className="a-dot" /> : null}
            <line x1={x(today)} x2={x(today)} y1={M.top} y2={M.top + h} className="a-marker-line" />
            <text x={x(today)} y={M.top - 4} textAnchor="middle" className="a-axis-text">
              today
            </text>
            {labelDays.map((n, i) => (
              <text key={n} x={x(n)} y={height - 8} textAnchor={i === 0 ? 'start' : i === 2 ? 'end' : 'middle'} className="a-axis-text">
                {dayLabel(n)}
              </text>
            ))}
            <rect x={M.left} y={M.top} width={w} height={h} className="a-hover-area" onPointerMove={(e) => {
              const box = (e.currentTarget as SVGRectElement).getBoundingClientRect();
              const n = Math.round(first + ((e.clientX - box.left) / box.width) * (endDay - first));
              const p = series.find((s) => s.dayNum === n) ?? (n > lastPoint.dayNum ? lastPoint : series[0]);
              tip.show(e, [dayLabel(n), `Logged to date: ${((p?.cum ?? 0) / 3600).toFixed(1)} h`, `Budget: ${(budget / 3600).toFixed(1)} h`]);
            }} />
          </svg>
        );
      }}
    </ChartBox>
  );
}

// ------------------------------------------------------------------ view data table

export function DataTable({ caption, columns, rows }: { caption: string; columns: readonly string[]; rows: readonly (readonly (string | number)[])[] }) {
  const [open, setOpen] = useState(false);
  return (
    <details className="a-data" onToggle={(e) => setOpen((e.currentTarget as HTMLDetailsElement).open)}>
      <summary>View data</summary>
      {open ? (
        <div className="a-table-wrap">
          <table className="a-table tabular">
            <caption className="visually-hidden">{caption}</caption>
            <thead>
              <tr>
                {columns.map((c) => (
                  <th key={c} scope="col">
                    {c}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => (
                <tr key={i}>
                  {r.map((c, k) => (k === 0 ? <th key={k} scope="row">{c}</th> : <td key={k}>{c}</td>))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </details>
  );
}

export function useEscape(active: boolean, onEscape: () => void): void {
  useEffect(() => {
    if (!active) return;
    const h = (e: globalThis.KeyboardEvent): void => {
      if (e.key === 'Escape') onEscape();
    };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [active, onEscape]);
}

/** A name chip: project colour as a swatch, the name always as text. */
export function ProjectChip({ name, color }: { name: string; color: string }) {
  return (
    <span className="a-chip" style={{ background: color, color: readableText(color) }}>
      {name}
    </span>
  );
}
