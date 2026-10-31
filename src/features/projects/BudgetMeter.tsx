// A project's budget status: a labelled bar plus words ("86% of the fixed fee", "80% warning"), so the
// level never rests on colour alone. A fixed fee measured in money is masked while earnings are hidden.
import { MASK } from '../../lib/billing';
import type { Project } from '../../lib/types';
import { IconWarn } from '../../components/icons';
import { BUDGET_LEVEL_TEXT, NEEDS_TARGET_RATE_TEXT } from './projectLogic';
import './budget.css';

export function budgetBasisText(project: Pick<Project, 'budgetHours'>, basis: 'hours' | 'fee'): string {
  return basis === 'hours' ? `of ${project.budgetHours ?? 0} h` : 'of the fixed fee';
}

export function BudgetMeter({ project, hideEarnings, onSetRate }: { project: Project; hideEarnings: boolean; onSetRate?: () => void }) {
  const budget = project.figures.budget;
  if (!budget) return null;

  if (budget.needsTargetRate) {
    return (
      <p className="budget-need" data-testid="budget-need">
        <IconWarn /> <span>{NEEDS_TARGET_RATE_TEXT}.</span>{' '}
        {onSetRate && (
          <button type="button" className="link" onClick={onSetRate}>
            Set a price per hour<span className="visually-hidden"> for {project.name}</span>
          </button>
        )}
      </p>
    );
  }

  // Hours and percentages of hours are not money. A percentage of a fee is, so it hides with the fee.
  const moneyBasis = budget.basis === 'fee';
  const masked = hideEarnings && moneyBasis;
  const level = BUDGET_LEVEL_TEXT[budget.level];
  const basis = budgetBasisText(project, budget.basis);
  const percentText = masked ? MASK : `${budget.percent}%`;
  const summary = `${percentText} ${basis}`;
  return (
    <div className={`budget budget-l${budget.level}`} data-testid="budget" data-level={budget.level}>
      <div className="budget-text">
        <span className="budget-label">Budget used</span>
        <span className="tabular budget-percent">{summary}</span>
        {level && (
          <span className="budget-flag">
            <IconWarn /> {level}
          </span>
        )}
      </div>
      {!masked && (
        <div
          className="budget-bar"
          role="meter"
          aria-label={`Budget used, ${project.name}`}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.min(100, budget.percent)}
          aria-valuetext={`${summary}${level ? `, ${level}` : ''}`}
        >
          <span className="budget-fill" style={{ width: `${Math.min(100, budget.percent)}%` }} />
          <span className="budget-tick" aria-hidden="true" />
        </div>
      )}
    </div>
  );
}
