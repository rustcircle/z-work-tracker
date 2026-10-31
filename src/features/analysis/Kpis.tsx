// KPI cards: a headline figure, a sparkline of the period and an arrow against the previous period.
import { money as fmtMoney } from '../../lib/billing';
import type { Currency } from '../../lib/types';
import { Sparkline } from './charts';
import { fmtHM, fmtPct, fmtSignedPct } from './format';
import { moneyText } from './insights';
import type { Delta } from './stats';
import type { SecEnv } from './secenv';
import { InfoButton } from './ui';
import { MASK } from '../../lib/billing';

function DeltaBadge({ d, abs }: { d: Delta | null; abs: (v: number) => string }) {
  if (!d) return <span className="a-delta muted">No comparison</span>;
  const dir = d.abs > 0 ? 'up' : d.abs < 0 ? 'down' : 'flat';
  const arrow = dir === 'up' ? '▲' : dir === 'down' ? '▼' : '■';
  const text = d.pct === null ? `${d.abs >= 0 ? '+' : '-'}${abs(Math.abs(d.abs))}` : `${fmtSignedPct(d.pct)} (${d.abs >= 0 ? '+' : '-'}${abs(Math.abs(d.abs))})`;
  return (
    <span className="a-delta tabular" aria-label={`${dir === 'flat' ? 'Unchanged' : dir === 'up' ? 'Up' : 'Down'} ${text} against the previous period`}>
      <span aria-hidden="true">{arrow}</span> {text} <span className="muted">vs previous</span>
    </span>
  );
}

function Kpi({ title, info, value, sub, delta, abs, spark, sparkLabel, env }: { title: string; info: string; value: string; sub?: string; delta?: Delta | null; abs?: (v: number) => string; spark?: readonly (number | null)[]; sparkLabel?: string; env: SecEnv }) {
  return (
    <article className="a-kpi" aria-label={title}>
      <header>
        <h3>{title}</h3>
        <InfoButton id={info} openGlossary={env.openGlossary} />
      </header>
      <p className="a-kpi-value tabular">{value}</p>
      {sub ? <p className="a-kpi-sub tabular">{sub}</p> : null}
      <div className="a-kpi-foot">
        {delta !== undefined && abs ? <DeltaBadge d={delta} abs={abs} /> : <span />}
        {spark ? <Sparkline values={spark} ariaLabel={sparkLabel ?? `${title} over the period`} /> : null}
      </div>
    </article>
  );
}

/** Fixed-fee projects earn their fee, so the card shows the effective hourly rate instead of "No rate set". */
function FixedFeeKpi({ env }: { env: SecEnv }) {
  const f = env.m.fixedFee;
  const one = f.length === 1 ? f[0] : undefined;
  const rate = one && one.effectiveHourlyCents !== null && one.currency ? (env.hide ? MASK : `${fmtMoney(one.currency, one.effectiveHourlyCents)} per hour`) : null;
  return (
    <Kpi
      env={env}
      title="Fixed fee"
      info="money.fixedFeeRate"
      value={one ? (rate ?? 'Not enough data') : `${f.length} projects`}
      sub={one ? `${one.name}: effective hourly rate${one.feeCents !== null && one.currency ? `, fee ${env.hide ? MASK : fmtMoney(one.currency, one.feeCents)}` : ''}` : 'Effective hourly rate per project in Goals and money'}
    />
  );
}

export function KpiRow({ env }: { env: SecEnv }) {
  const { m, hide } = env;
  const v = m.volume;
  const pts = m.series.points;
  const showBoth = m.billableAvailable && (m.roundingActive || m.pieces.pauseSecs > 0);
  const earn = (['EUR', 'USD'] as const).filter((c) => m.money.numerators[c] !== undefined);
  const firstCur: Currency | undefined = earn[0];
  const earnSpark = firstCur ? m.money.earnings[firstCur]?.map((p) => p.numerator) : undefined;
  const focusSpark = m.focus.daily.map((d) => d.ratio);
  const weekly = m.goals.weekly;
  const daily = m.goals.daily;
  return (
    <div className="a-kpis" role="list" aria-label="Key figures">
      <div role="listitem">
        <Kpi
          env={env}
          title="Total time"
          info="volume.total"
          value={fmtHM(v.primary)}
          sub={showBoth ? `Billable ${fmtHM(v.billable)}${m.pieces.pauseSecs > 0 && m.pieces.pausesShown ? ` (includes ${fmtHM(m.pieces.pauseSecs)} billable pauses)` : ''} · Exact ${fmtHM(v.exact)}` : 'Exact (no rounding applies)'}
          delta={v.deltaTotal}
          abs={fmtHM}
          spark={pts.map((p) => p.secs)}
        />
      </div>
      <div role="listitem">
        <Kpi env={env} title="Active days" info="volume.activeDays" value={`${v.activeDays} of ${v.elapsedDays || v.calendarDays}`} sub={v.elapsedDays ? 'days with logged time' : 'period not started'} delta={v.deltaActive} abs={(n) => String(Math.round(n))} spark={pts.map((p) => (p.exact > 0 ? 1 : 0))} sparkLabel="Active days over the period" />
      </div>
      <div role="listitem">
        <Kpi env={env} title="Average per active day" info="volume.avgActiveDay" value={v.avgPerActiveDay === null ? 'Not enough data' : fmtHM(v.avgPerActiveDay)} sub={v.avgPerCalendarDay === null ? undefined : `${fmtHM(v.avgPerCalendarDay)} per calendar day`} delta={v.deltaAvgActive} abs={fmtHM} spark={pts.map((p) => (p.exact > 0 ? p.secs : null))} />
      </div>
      <div role="listitem">
        <Kpi env={env} title="Sessions" info="focus.sessions" value={String(m.focus.sessions)} sub={m.focus.avg === null ? 'Not enough data' : `average ${fmtHM(m.focus.avg)}, longest ${fmtHM(m.focus.longest ?? 0)}`} spark={m.focus.daily.map((d) => d.switches)} sparkLabel="Context switches per day" />
      </div>
      <div role="listitem">
        <Kpi env={env} title="Focus ratio" info="focus.ratio" value={m.focus.focusRatio === null ? 'Not enough data' : fmtPct(m.focus.focusRatio)} sub={`${m.focus.pauseCount} pauses, ${fmtHM(m.focus.pauseSecs)} paused`} spark={focusSpark} />
      </div>
      {m.money.available && (earn.length > 0 || m.money.missingRate.length > 0) ? (
        <div role="listitem">
          <Kpi
            env={env}
            title="Earnings"
            info="money.earnings"
            value={earn.length ? moneyText(m.money.numerators, hide) : 'No rate set'}
            sub={firstCur && m.money.hourlyCents[firstCur] !== undefined ? `${hide ? MASK : fmtMoney(firstCur, m.money.hourlyCents[firstCur] as number)} per Exact hour` : undefined}
            spark={hide ? undefined : earnSpark}
            sparkLabel="Earnings over the period"
          />
          {m.money.missingRate.length > 0 ? (
            <button type="button" className="a-link a-kpi-link" onClick={() => env.jumps.openProject(m.money.missingRate[0] as string)}>
              No rate set for {m.money.missingRate.length} project{m.money.missingRate.length === 1 ? '' : 's'}: set a rate
            </button>
          ) : null}
        </div>
      ) : null}
      {m.fixedFee.length > 0 ? (
        <div role="listitem">
          <FixedFeeKpi env={env} />
        </div>
      ) : null}
      <div role="listitem">
        {weekly ? (
          <Kpi env={env} title="Weekly target" info="goals.weekly" value={fmtPct(weekly.attainment)} sub={`${fmtHM(weekly.secs)} of ${fmtHM(weekly.target)}`} />
        ) : daily ? (
          <Kpi env={env} title="Daily target" info="goals.daily" value={fmtPct(daily.attainment)} sub={`${fmtHM(daily.secs)} of ${fmtHM(daily.target)}`} />
        ) : (
          <Kpi env={env} title="Day streak" info="consistency.streak" value={`${m.consistency.streakCurrent} day${m.consistency.streakCurrent === 1 ? '' : 's'}`} sub={`longest in period ${m.consistency.streakLongest}`} />
        )}
      </div>
    </div>
  );
}
