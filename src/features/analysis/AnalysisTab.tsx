// The Analysis tab: controls, key figures, written insights and one section per metric family.
import { useCallback, useEffect, useMemo, useState } from 'react';

import { useApp } from '../../app/store';
import { dayOf, zoneLabel } from '../../lib/tz';
import { ActiveZoneBar } from '../zones';
import './analysis.css';
import { PatternDefs } from './charts';
import { Controls } from './Controls';
import type { DrillSel } from './drill';
import { drillSpans, NO_FILTERS, prepare, type Filters, type Params } from './engine';
import { buildInsights } from './insights';
import { KpiRow } from './Kpis';
import { useJumps } from './nav';
import { analyze, type Basis, type Metrics } from './metrics';
import { defaultRange, type RangeSpec } from './range';
import { Consistency, Focus, Goals } from './SectionsB';
import { Overview, Projects, Tasks, TimeOfDay } from './SectionsA';
import { ShiftsSection, ZonesSection } from './SectionsC';
import type { SecEnv } from './secenv';
import { Card, DrillPanel, GlossaryDialog, InfoButton, Invite } from './ui';
import { publishAnalysisView } from './view';

const SECTIONS = [
  ['overview', 'Overview'],
  ['time', 'Time of day'],
  ['projects', 'Projects'],
  ['tasks', 'Tasks'],
  ['focus', 'Focus'],
  ['consistency', 'Consistency'],
  ['goals', 'Goals and money'],
  ['shifts', 'Shifts'],
  ['zones', 'Zones'],
] as const;

type Computed = { ok: true; m: Metrics } | { ok: false; error: string };

export function AnalysisTab() {
  const { snapshot, nowSec, zones } = useApp();
  const zone = zones.active;
  const [range, setRange] = useState<RangeSpec>(() => defaultRange(dayOf(nowSec, zone)));
  const [filters, setFilters] = useState<Filters>(NO_FILTERS);
  const [basis, setBasis] = useState<Basis>('billable');
  const [compare, setCompare] = useState(true);
  const [drill, setDrill] = useState<DrillSel | null>(null);
  const [glossary, setGlossary] = useState<{ open: boolean; focus: string | null }>({ open: false, focus: null });

  const live = useMemo(() => snapshot.segments.some((s) => s.end === null && s.provisionalEnd === null), [snapshot]);
  // Analysis follows the running segment every 10 s, and the calendar once a minute otherwise.
  const clock = live ? Math.floor(nowSec / 10) * 10 : Math.floor(nowSec / 60) * 60;
  const params = useMemo<Params>(() => ({ zone, range, filters, compare }), [zone, range, filters, compare]);

  const computed = useMemo<Computed>(() => {
    try {
      return { ok: true, m: analyze(snapshot, params, clock, basis) };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  }, [snapshot, params, clock, basis]);

  useEffect(() => {
    publishAnalysisView({ range, filters, basis, compare });
  }, [range, filters, basis, compare]);

  const jumps = useJumps();
  const openGlossary = useCallback((id: string) => setGlossary({ open: true, focus: id }), []);
  const projects = useMemo(() => new Map(snapshot.projects.map((p) => [p.id, p])), [snapshot.projects]);
  const tasks = useMemo(() => new Map(snapshot.tasks.map((t) => [t.id, t])), [snapshot.tasks]);
  const drillSpanList = useMemo(() => (drill && computed.ok ? drillSpans(prepare(snapshot, params), clock) : []), [drill, computed, snapshot, params, clock]);

  if (!computed.ok) {
    return (
      <section aria-label="Analysis" className="a-root">
        <Invite title="Analysis could not be computed">{computed.error}</Invite>
      </section>
    );
  }
  const m = computed.m;
  const env: SecEnv = {
    m,
    snapshot,
    hide: snapshot.prefs.hideEarnings,
    nowSec: clock,
    pname: (id) => projects.get(id)?.name ?? 'Unknown project',
    pcolor: (id) => projects.get(id)?.color ?? '#6b7280',
    tname: (id) => tasks.get(id)?.name ?? 'Unknown task',
    order: m.projects.map((p) => p.id),
    drill: setDrill,
    openGlossary,
    jumps,
  };
  const insights = buildInsights(m, { hideEarnings: env.hide, names: new Map(snapshot.projects.map((p) => [p.id, p.name])) });
  const go = (id: string): void => {
    const reduce = typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    document.getElementById(`analysis-${id}`)?.scrollIntoView?.({ behavior: reduce ? 'auto' : 'smooth', block: 'start' });
  };

  return (
    <section aria-label="Analysis" className="a-root">
      <PatternDefs />
      <header className="a-top">
        <h1>Analysis</h1>
        <ActiveZoneBar />
        <p className="muted a-zoneline">
          Times and days are shown in <strong>{zoneLabel(zone, clock)}</strong>. Exact totals do not change with the zone; Billable can.
          {live ? ' The running task is included and refreshes every 10 seconds.' : ''}
        </p>
      </header>
      <Controls
        snapshot={snapshot}
        today={dayOf(clock, zone)}
        range={range}
        setRange={setRange}
        periodLabel={m.period.label}
        filters={filters}
        setFilters={setFilters}
        basis={m.requestedBasis}
        setBasis={setBasis}
        billableAvailable={m.billableAvailable}
        compare={compare}
        setCompare={setCompare}
        onGlossary={() => setGlossary({ open: true, focus: null })}
      />
      {m.prevPeriod ? (
        <p className="muted a-zoneline" role="status">
          Comparing with {m.prevPeriod.label}.
        </p>
      ) : null}
      <KpiRow env={env} />
      {m.hasData ? null : (
        <Invite title="No logged time here">
          Nothing is logged in {m.period.label}
          {filters.projectIds.length || filters.taskIds.length || filters.band !== null || filters.shiftKey !== null ? ' with these filters' : ''}. Pick another range, clear the filters, or start a task on the Timeline.
        </Invite>
      )}
      <article className="a-card a-insights" aria-labelledby="insights-h">
        <header className="a-card-head">
          <h2 id="insights-h">Insights</h2>
          <InfoButton id="basis" openGlossary={openGlossary} />
        </header>
        {insights.length === 0 ? (
          <p className="muted">Insights appear once there is logged time in the period.</p>
        ) : (
          <ul className="a-insight-list">
            {insights.map((i) => (
              <li key={i.id}>
                <span>{i.text}</span>
                <span className="a-trace">
                  {i.metrics.map((id) => (
                    <button key={id} type="button" className="a-link" onClick={() => openGlossary(id)} aria-label={`Metric ${id}`}>
                      {id}
                    </button>
                  ))}
                </span>
              </li>
            ))}
          </ul>
        )}
        <p className="muted a-note">Each sentence is built from the named metrics by fixed rules. No scores, no advice.</p>
      </article>
      <nav className="a-nav" aria-label="Analysis sections">
        {SECTIONS.map(([id, label]) => (
          <button key={id} type="button" className="a-btn" onClick={() => go(id)}>
            {label}
          </button>
        ))}
      </nav>
      <Overview env={env} />
      <TimeOfDay env={env} />
      <Projects env={env} />
      <Tasks env={env} />
      <Focus env={env} />
      <Consistency env={env} />
      <Goals env={env} />
      <ShiftsSection env={env} />
      <ZonesSection env={env} />
      <GlossaryDialog open={glossary.open} focusId={glossary.focus} onClose={() => setGlossary({ open: false, focus: null })} />
      {drill ? <DrillPanel sel={drill} ctx={{ spans: drillSpanList, zone, clientZone: zones.client, nowSec: clock, projects, tasks }} onClose={() => setDrill(null)} /> : null}
      <Card title="About these figures">
        <p className="muted">
          Everything here is computed on this device from your logged segments. Logged time measures logged time, not output. Raw UTC instants are the truth; the zone only affects display and grouping.
        </p>
      </Card>
    </section>
  );
}
