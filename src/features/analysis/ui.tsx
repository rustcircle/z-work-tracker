// Shared building blocks of the Analysis screen: cards, info popovers, the glossary dialog and
// the drill-down panel.
import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react';

import { Modal } from '../../components/ui';
import { clockAt, dayOf, zoneLabel, cityOf } from '../../lib/tz';
import { DataTable, ProjectChip, useEscape } from './charts';
import { drillInto, type DrillResult, type DrillSel } from './drill';
import { fmtHM, fmtHMS } from './format';
import { glossaryEntry, searchGlossary, type GlossaryEntry } from './glossary';
import type { SpanRec } from './engine';
import { taggingOf } from './tagSets';
import { MONTH_SHORT, WEEKDAY_SHORT, dayNum, weekdayIndex } from './range';
import type { Project, Tag, Task } from '../../lib/types';

export function dayText(day: string): string {
  const n = dayNum(day);
  return `${WEEKDAY_SHORT[weekdayIndex(n)]} ${Number(day.slice(8))} ${MONTH_SHORT[Number(day.slice(5, 7)) - 1]}`;
}

// ------------------------------------------------------------------ info popover

export function GlossaryBody({ entry }: { entry: GlossaryEntry }) {
  return (
    <>
      <p className="a-pop-title">
        {entry.name} <span className="a-basis">{entry.basis === 'Neither' ? 'Not time-based' : `Uses ${entry.basis}`}</span>
      </p>
      <p>{entry.definition}</p>
      <p className="a-formula">
        <strong>Formula:</strong> {entry.formula}
      </p>
    </>
  );
}

export function InfoButton({ id, openGlossary }: { id: string; openGlossary?: (id: string) => void }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLSpanElement>(null);
  const entry = glossaryEntry(id);
  const popId = useId();
  useEscape(open, () => setOpen(false));
  useEffect(() => {
    if (!open) return;
    const h = (e: MouseEvent): void => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', h);
    return () => document.removeEventListener('mousedown', h);
  }, [open]);
  if (!entry) return null;
  return (
    <span className="a-info" ref={ref}>
      <button type="button" className="a-info-btn" aria-label={`About ${entry.name}`} aria-expanded={open} aria-controls={popId} onClick={() => setOpen((o) => !o)}>
        i
      </button>
      {open ? (
        <div className="a-pop" id={popId} role="note">
          <GlossaryBody entry={entry} />
          {openGlossary ? (
            <button type="button" className="a-link" onClick={() => openGlossary(id)}>
              Open in the glossary
            </button>
          ) : null}
        </div>
      ) : null}
    </span>
  );
}

// ------------------------------------------------------------------ cards and sections

export function Section({ id, title, lede, children }: { id: string; title: string; lede?: string; children: ReactNode }) {
  return (
    <section className="a-section" id={`analysis-${id}`} aria-labelledby={`analysis-${id}-h`} data-section={id}>
      <header className="a-section-head">
        <h2 id={`analysis-${id}-h`}>{title}</h2>
        {lede ? <p className="muted">{lede}</p> : null}
      </header>
      <div className="a-grid-cards">{children}</div>
    </section>
  );
}

export function Card({
  title,
  info,
  openGlossary,
  wide,
  children,
  data,
  note,
}: {
  title: string;
  info?: string;
  openGlossary?: (id: string) => void;
  wide?: boolean;
  children: ReactNode;
  data?: { caption: string; columns: string[]; rows: (string | number)[][] };
  note?: ReactNode;
}) {
  return (
    <article className={`a-card ${wide ? 'a-wide' : ''}`}>
      <header className="a-card-head">
        <h3>{title}</h3>
        {info ? <InfoButton id={info} {...(openGlossary ? { openGlossary } : {})} /> : null}
      </header>
      {children}
      {note ? <p className="a-note muted">{note}</p> : null}
      {data ? <DataTable caption={data.caption} columns={data.columns} rows={data.rows} /> : null}
    </article>
  );
}

export function Stat({ label, value, sub, info, openGlossary }: { label: string; value: string; sub?: string; info?: string; openGlossary?: (id: string) => void }) {
  return (
    <div className="a-stat">
      <dt>
        {label}
        {info ? <InfoButton id={info} {...(openGlossary ? { openGlossary } : {})} /> : null}
      </dt>
      <dd className="tabular">
        {value}
        {sub ? <span className="a-stat-sub">{sub}</span> : null}
      </dd>
    </div>
  );
}

export function Invite({ title, children }: { title: string; children: ReactNode }) {
  return (
    <article className="a-card a-wide a-invite">
      <h3>{title}</h3>
      <p>{children}</p>
    </article>
  );
}

// ------------------------------------------------------------------ glossary dialog

export function GlossaryDialog({ open, focusId, onClose }: { open: boolean; focusId: string | null; onClose: () => void }) {
  const [q, setQ] = useState('');
  const list = useMemo(() => searchGlossary(q), [q]);
  useEffect(() => {
    if (open && focusId) document.getElementById(`gloss-${focusId}`)?.scrollIntoView?.({ block: 'center' });
  }, [open, focusId]);
  return (
    <Modal open={open} title="Metrics glossary" onClose={onClose} wide>
      <label className="a-field">
        <span>Search metrics</span>
        <input type="search" data-autofocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Name, formula or Exact / Billable" />
      </label>
      <p className="muted a-count" role="status">
        {list.length} of {searchGlossary('').length} metrics
      </p>
      <div className="a-gloss-list">
        {list.map((e) => (
          <article key={e.id} id={`gloss-${e.id}`} className={`a-gloss ${e.id === focusId ? 'a-gloss-focus' : ''}`}>
            <h3>
              {e.name} <span className="a-basis">{e.basis === 'Neither' ? 'Not time-based' : `Uses ${e.basis}`}</span>
            </h3>
            <p className="muted a-family">{e.family}</p>
            <p>{e.definition}</p>
            <p className="a-formula">
              <strong>Formula:</strong> {e.formula}
            </p>
          </article>
        ))}
        {list.length === 0 ? <p>No metric matches &ldquo;{q}&rdquo;.</p> : null}
      </div>
    </Modal>
  );
}

// ------------------------------------------------------------------ drill-down

/** Tag names with their colour as a swatch; the name is always written out. */
export function TagChips({ ids, tags }: { ids: readonly string[]; tags: ReadonlyMap<string, Tag> }) {
  const live = ids.map((id) => tags.get(id)).filter((t): t is Tag => t !== undefined && !t.deleted);
  if (live.length === 0) return null;
  return (
    <span className="a-tags">
      {live.map((t) => (
        <span key={t.id} className="a-tag">
          <span className="a-dot-sw" style={{ background: t.color }} aria-hidden="true" />
          {t.name}
        </span>
      ))}
    </span>
  );
}

export interface DrillContext {
  spans: readonly SpanRec[];
  zone: string;
  clientZone: string | null;
  nowSec: number;
  projects: ReadonlyMap<string, Project>;
  tasks: ReadonlyMap<string, Task>;
  /**
   * Every tag by id, deleted ones too: the task rows name their tags, and the drill counts time under the tags that exist
   * (`taggingOf` and `TagChips` leave a deleted tag out). Not optional: with none, no tag would exist and a drill by tag
   * would find nothing.
   */
  tags: ReadonlyMap<string, Tag>;
}

const MAX_SEGMENTS = 60;

/** The panel lies under the dialogs (layer 50 in styles/ui.css) and the toasts (60), whatever layer analysis.css gives it: a dialog opened over it is not covered by it. */
const PANEL_LAYER = 49;

export function DrillPanel({ sel, ctx, onClose }: { sel: DrillSel; ctx: DrillContext; onClose: () => void }) {
  const res: DrillResult = useMemo(() => drillInto(ctx.spans, ctx.zone, sel, taggingOf(ctx.tasks.values(), ctx.tags.values())), [ctx.spans, ctx.zone, ctx.tasks, ctx.tags, sel]);
  const [all, setAll] = useState(false);
  const ref = useRef<HTMLElement>(null);
  // Where focus was before the panel took it, to give it back when the panel closes. A chart mark is an SVG element.
  const opener = useRef<HTMLElement | SVGElement | null>(null);
  useEscape(true, onClose);
  useEffect(() => {
    const active = document.activeElement;
    if ((active instanceof HTMLElement || active instanceof SVGElement) && !ref.current?.contains(active)) opener.current = active;
    ref.current?.focus();
  }, [sel]);
  useEffect(
    () => () => {
      // Only if focus was left with the panel: someone who has moved on to another control keeps it.
      if (opener.current?.isConnected && (document.activeElement === null || document.activeElement === document.body)) opener.current.focus();
    },
    [],
  );
  const both = ctx.clientZone !== null && ctx.clientZone !== ctx.zone;
  const range = (s: number, e: number, zone: string): string => {
    const day = dayOf(s, zone);
    const endDay = dayOf(e, zone);
    return `${dayText(day)} ${clockAt(s, zone)}-${endDay === day ? '' : `${dayText(endDay)} `}${clockAt(e, zone)}`;
  };
  const shown = all ? res.segments : res.segments.slice(0, MAX_SEGMENTS);
  return (
    <aside className="a-drill" style={{ zIndex: PANEL_LAYER }} role="dialog" aria-label={`Drill-down: ${sel.title}`} tabIndex={-1} ref={ref}>
      <header className="a-modal-head">
        <h2>{sel.title}</h2>
        <button type="button" className="a-btn" onClick={onClose}>
          Close
        </button>
      </header>
      <p className="tabular a-drill-total">
        {fmtHM(res.totalSecs)} exact ({fmtHMS(res.totalSecs)}) in {res.segments.length} segment{res.segments.length === 1 ? '' : 's'} on {res.tasks.length} task{res.tasks.length === 1 ? '' : 's'}
      </p>
      {res.tasks.length === 0 ? <p className="muted">No logged time behind this mark.</p> : null}
      <h3>Tasks</h3>
      <ul className="a-drill-tasks">
        {res.tasks.map((t) => {
          const p = ctx.projects.get(t.projectId);
          return (
            <li key={t.taskId}>
              <span>{ctx.tasks.get(t.taskId)?.name ?? t.taskId}</span>
              {p ? <ProjectChip name={p.name} color={p.color} /> : null}
              <TagChips ids={ctx.tasks.get(t.taskId)?.tags ?? []} tags={ctx.tags} />
              <span className="tabular">{fmtHM(t.secs)}</span>
            </li>
          );
        })}
      </ul>
      <h3>Segments{both ? ` (${cityOf(ctx.zone)} / ${cityOf(ctx.clientZone as string)})` : ` (${zoneLabel(ctx.zone, ctx.nowSec)})`}</h3>
      <ol className="a-drill-segs">
        {shown.map((s) => (
          <li key={`${s.taskId}-${s.start}`}>
            <span className="tabular">{range(s.start, s.end, ctx.zone)}</span>
            {both ? <span className="tabular muted"> / {range(s.start, s.end, ctx.clientZone as string)}</span> : null}
            <span className="a-seg-meta">
              {ctx.tasks.get(s.taskId)?.name ?? s.taskId} · {fmtHM(s.secs)}
              {s.live ? ' · running' : ''}
            </span>
          </li>
        ))}
      </ol>
      {res.segments.length > MAX_SEGMENTS && !all ? (
        <button type="button" className="a-btn" onClick={() => setAll(true)}>
          Show all {res.segments.length} segments
        </button>
      ) : null}
    </aside>
  );
}
