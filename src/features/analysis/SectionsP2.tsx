// Phase 2 sections: billable pauses and thinking time, time by tag, fixed fees and budget status.
import { MASK, money as fmtMoney } from '../../lib/billing';
import type { Currency } from '../../lib/types';
import { Columns, HBars, Legend, timeScale, type Col, type HRow } from './charts';
import { fmtHM, fmtHMS, fmtPct, fmtSignedPct } from './format';
import { UNTAGGED_COLOR, type BudgetAlert, type FixedFeeStat, type TagStat } from './fam-p2';
import type { SecEnv } from './secenv';
import { basisWord, tipTime } from './secenv';
import { Card, Invite, Section, Stat } from './ui';

const EMPTY = 'No time logged in this period. Try another range or clear the filters.';

/** A price, or the mask while earnings are hidden. */
export const priceText = (env: SecEnv, currency: Currency | null, cents: number | null): string => {
  if (cents === null || currency === null) return 'Not set';
  return env.hide ? MASK : fmtMoney(currency, cents);
};

/** "Fixed fee €1,000.00, effective hourly rate €38.10", masked when earnings are hidden. */
export function feeLine(env: SecEnv, f: FixedFeeStat): string {
  const fee = `Fixed fee ${priceText(env, f.currency, f.feeCents)}`;
  if (f.effectiveHourlyCents === null || f.currency === null) return `${fee}, no billable time yet`;
  return `${fee}, effective hourly rate ${env.hide ? MASK : fmtMoney(f.currency, f.effectiveHourlyCents)}`;
}

// ------------------------------------------------------------------ pauses, thinking, unconfirmed

export function PiecesCard({ env }: { env: SecEnv }) {
  const { m } = env;
  const p = m.pieces;
  const none = p.pauseSecs === 0 && p.thinkingSecs === 0;
  const cols: Col[] = p.series.map((pt) => ({
    key: pt.key,
    label: pt.label,
    segs: [
      ...(p.pausesShown && pt.pause > 0 ? [{ id: 'pause', label: 'Billable pauses', value: pt.pause, concept: 'paused' as const }] : []),
      ...(pt.thinking > 0 ? [{ id: 'thinking', label: 'Thinking time', value: pt.thinking, concept: 'worked' as const }] : []),
    ],
    tip: [pt.label, ...(p.pausesShown ? [tipTime('Billable pauses', pt.pause)] : []), tipTime('Thinking time', pt.thinking)],
  }));
  const max = Math.max(0, ...p.series.map((pt) => (p.pausesShown ? pt.pause : 0) + pt.thinking));
  const vs = (secs: number | null): string => (secs === null ? '' : ` Previous period ${fmtHM(secs)}.`);
  return (
    <Card
      title="Billable pauses and thinking"
      info="pauses.billable"
      openGlossary={env.openGlossary}
      wide
      note="Billable pauses are Billable time only: they are not worked time, so Exact, sessions, focus and the time-of-day charts leave them out. Thinking time is worked time that you kept after time away. Unconfirmed time is in no total until you confirm it."
      data={{
        caption: 'Billable pauses and thinking per period',
        columns: ['Period', 'Billable pauses', 'Thinking time'],
        rows: p.series.map((pt) => [pt.label, p.pausesShown ? fmtHMS(pt.pause) : 'Hidden', fmtHMS(pt.thinking)]),
      }}
    >
      <dl className="a-stats">
        <Stat
          label="Billable pauses"
          value={p.pausesShown ? fmtHM(p.pauseSecs) : 'Hidden'}
          sub={p.pausesShown ? ` in Billable, not in Exact.${vs(p.prevPauseSecs)}` : ' Pauses belong to Billable, which is off under a band or shift filter.'}
          info="pauses.billable"
          openGlossary={env.openGlossary}
        />
        <Stat label="Thinking time" value={fmtHM(p.thinkingSecs)} sub={` in Exact and Billable.${vs(p.prevThinkingSecs)}`} info="time.thinking" openGlossary={env.openGlossary} />
        <Stat
          label="Unconfirmed time"
          value={p.unconfirmed.shown ? fmtHM(p.unconfirmed.secs) : 'Hidden'}
          sub={p.unconfirmed.shown ? ` counts nowhere until confirmed (${p.unconfirmed.count} stretch${p.unconfirmed.count === 1 ? '' : 'es'}).` : ' Hidden while a band or shift filter is on.'}
          info="time.unconfirmed"
          openGlossary={env.openGlossary}
        />
      </dl>
      {none ? (
        <p className="muted a-note">No billable pauses or thinking time in this period.</p>
      ) : (
        <>
          <Legend
            items={[
              ...(p.pausesShown ? [{ key: 'pause', label: 'Billable pauses', concept: 'paused' as const }] : []),
              { key: 'thinking', label: 'Thinking time', concept: 'worked' as const },
            ]}
          />
          <Columns cols={cols} scale={timeScale(max)} yTitle="hours" ariaLabel="Billable pause and thinking time per period" empty={EMPTY} />
        </>
      )}
    </Card>
  );
}

// ------------------------------------------------------------------ time by tag

function tagRow(env: SecEnv, t: TagStat): HRow {
  return {
    key: t.id ?? '__none',
    label: t.name,
    value: t.secs,
    valueText: `${fmtHM(t.secs)}${t.share === null ? '' : ` · ${fmtPct(t.share)}`}`,
    fill: t.color,
    tip: [
      t.name,
      tipTime(basisWord(env), t.secs),
      `Share of total time: ${t.share === null ? 'n/a' : fmtPct(t.share, 1)} (shares overlap)`,
      `Exact ${fmtHM(t.exact)} · Billable ${fmtHM(t.billableSecs)}`,
      `${t.taskCount} task${t.taskCount === 1 ? '' : 's'}, each counted fully`,
      ...(t.delta ? [`Previous period: ${fmtHM(t.delta.prev)}${t.delta.pct === null ? '' : ` (${fmtSignedPct(t.delta.pct)})`}`] : []),
    ],
    onSelect: () => env.drill({ title: t.id === null ? 'Tasks with no tag' : `Tag: ${t.name}`, tagId: t.id }),
  };
}

export function TagsSection({ env }: { env: SecEnv }) {
  const { m } = env;
  const t = m.tags;
  const all: TagStat[] = [...t.stats, ...(t.untagged ? [t.untagged] : [])];
  const rows = all.map((x) => tagRow(env, x));
  return (
    <Section id="tags" title="Tags" lede="A task with two tags counts fully in each, so tags overlap and are never added into a total.">
      {!t.anyTags ? (
        <Invite title="No tags yet">Tags label your tasks (concept, revision, client call). Add tags in Settings, tag your tasks, and this section shows where the time goes by tag.</Invite>
      ) : (
        <Card
          title="Time by tag"
          info="tags.time"
          openGlossary={env.openGlossary}
          wide
          note={
            <>
              Each bar is the full time of every task that carries the tag. {t.multiTagTasks > 0 ? `${t.multiTagTasks} task${t.multiTagTasks === 1 ? ' carries' : 's carry'} more than one tag and ${t.multiTagTasks === 1 ? 'counts' : 'count'} fully in each. ` : ''}
              Shares are of the total time of all tasks ({fmtHM(t.total)}) and overlap, so they can add up to more than 100%. There is no total across tags.
            </>
          }
          data={{
            caption: 'Time by tag (a task with two tags counts fully in each; no total)',
            columns: ['Tag', `${basisWord(env)} (chart basis)`, 'Share of total time (overlaps)', 'Exact', 'Billable', 'Tasks', 'Change vs previous'],
            rows: all.map((x) => [x.name, fmtHMS(x.secs), x.share === null ? '' : fmtPct(x.share, 1), fmtHMS(x.exact), fmtHMS(x.billableSecs), x.taskCount, x.delta?.pct == null ? '' : fmtSignedPct(x.delta.pct)]),
          }}
        >
          <Legend items={all.map((x) => ({ key: x.id ?? '__none', label: x.name, color: x.id === null ? UNTAGGED_COLOR : x.color }))} />
          <HBars rows={rows} ariaLabel="Time by tag. A task with two tags counts fully in each, so the bars overlap" empty={EMPTY} />
        </Card>
      )}
    </Section>
  );
}

// ------------------------------------------------------------------ fixed fee

export function FixedFeeCard({ env }: { env: SecEnv }) {
  const { m } = env;
  if (m.fixedFee.length === 0) return null;
  const budgetOf = (id: string): BudgetAlert | undefined => m.budgetStatus.find((b) => b.projectId === id);
  return (
    <Card
      title="Fixed-fee projects"
      info="money.fixedFeeRate"
      openGlossary={env.openGlossary}
      wide
      note="A fixed-fee project earns its fee, not an hourly rate. The effective hourly rate is the fee over all billable hours of the project, including billable pauses, so it ignores the date range and the filters other than Projects."
    >
      <div className="a-table-wrap" role="region" aria-label="Fixed-fee projects, scrollable table" tabIndex={0}>
        <table className="a-table tabular">
          <caption className="visually-hidden">Fixed-fee projects with their effective hourly rate</caption>
          <thead>
            <tr>
              <th scope="col">Project</th>
              <th scope="col">Fixed fee</th>
              <th scope="col">Billable hours</th>
              <th scope="col">Effective hourly rate</th>
              <th scope="col">Budget used</th>
            </tr>
          </thead>
          <tbody>
            {m.fixedFee.map((f) => {
              const b = budgetOf(f.projectId);
              return (
                <tr key={f.projectId}>
                  <th scope="row">{f.name}</th>
                  <td>{priceText(env, f.currency, f.feeCents)}</td>
                  <td>{fmtHM(f.billableSecs)}</td>
                  <td>{f.effectiveHourlyCents === null || f.currency === null ? 'Not enough data' : env.hide ? MASK : `${fmtMoney(f.currency, f.effectiveHourlyCents)} per hour`}</td>
                  <td>{b === undefined ? 'No budget' : b.needsTargetRate ? 'Needs a price per hour' : `${b.percent}%`}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

// ------------------------------------------------------------------ budget status

const LEVEL_TEXT: Record<0 | 80 | 100, { glyph: string; text: string }> = {
  0: { glyph: '✓', text: 'Within budget' },
  80: { glyph: '⚠', text: 'Warning: 80% reached' },
  100: { glyph: '✖', text: 'Over budget: 100% reached' },
};

function budgetBasisText(env: SecEnv, b: BudgetAlert): string {
  if (b.basis === 'hours') return `Basis: hours. Billable time against a budget of ${b.budgetHours ?? 0} h.`;
  return `Basis: fee. Time valued at the project's rates against the fixed fee of ${priceText(env, b.currency, b.feeCents)}.`;
}

export function BudgetStatusCard({ env }: { env: SecEnv }) {
  const { m } = env;
  if (m.budgetStatus.length === 0) return null;
  return (
    <Card
      title="Budget status"
      info="budget.used"
      openGlossary={env.openGlossary}
      wide
      note="Whole percent, rounded down. 80% is a warning and 100% is over budget. Measured over the whole life of the project: the date range and the filters other than Projects do not apply."
      data={{
        caption: 'Budget status per project',
        columns: ['Project', 'Basis', 'Used', 'Status'],
        rows: m.budgetStatus.map((b) => [b.name, b.basis === 'hours' ? 'Hours' : 'Fee', b.needsTargetRate ? 'Needs a price per hour' : `${b.percent}%`, b.needsTargetRate ? 'Not measurable' : LEVEL_TEXT[b.level].text]),
      }}
    >
      <ul className="a-budget-list">
        {m.budgetStatus.map((b) => {
          const lv = LEVEL_TEXT[b.level];
          const w = Math.min(100, Math.max(0, b.percent));
          return (
            <li key={b.projectId} className={`a-budget a-budget-${b.needsTargetRate ? 'na' : b.level}`} data-level={b.needsTargetRate ? 'na' : b.level}>
              <div className="a-budget-head">
                <span className="a-budget-name">
                  <span className="a-dot-sw" style={{ background: b.color }} aria-hidden="true" />
                  {b.name}
                </span>
                {b.needsTargetRate ? (
                  <span className="a-badge">Not measurable</span>
                ) : (
                  <span className="a-badge" data-testid={`budget-level-${b.projectId}`}>
                    <span aria-hidden="true">{lv.glyph}</span> {lv.text}
                  </span>
                )}
              </div>
              {b.needsTargetRate ? (
                <p className="a-budget-msg">
                  A fixed fee needs a price per hour to measure against.{' '}
                  <button type="button" className="a-link" onClick={() => env.jumps.openProject(b.projectId)}>
                    Set a rate for {b.name}
                  </button>
                </p>
              ) : (
                <>
                  <div className="a-bar" role="img" aria-label={`${b.name}: ${b.percent}% of the ${b.basis === 'hours' ? 'hours budget' : 'fixed fee'} used. ${lv.text}.`}>
                    <div className="a-bar-fill" style={{ width: `${w}%` }} />
                    <span className="a-bar-tick" style={{ left: '80%' }} aria-hidden="true" />
                  </div>
                  <p className="a-budget-msg tabular">
                    <strong>{b.percent}% used.</strong> {budgetBasisText(env, b)}
                  </p>
                </>
              )}
            </li>
          );
        })}
      </ul>
    </Card>
  );
}
