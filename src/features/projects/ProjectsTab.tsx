import { useEffect, useMemo, useState } from 'react';

import { useApp } from '../../app/store';
import { api } from '../../lib/api';
import { MASK } from '../../lib/billing';
import type { Project } from '../../lib/types';
import { useNav } from '../../components/nav';
import { Badge, Button, Card, Modal, Swatch } from '../../components/ui';
import { IconArchive, IconEdit, IconPlus, IconRestore, IconTrash } from '../../components/icons';
import { useCommands } from '../../components/useCommands';
import { BudgetMeter } from './BudgetMeter';
import { ProjectForm } from './ProjectForm';
import { effectiveRateText, feeText, rateAt, rateText } from './projectLogic';

export function ProjectsTab() {
  const { snapshot, nowSec } = useApp();
  const nav = useNav();
  const { act } = useCommands();
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<string | null>(nav.focusProject);
  const [deleting, setDeleting] = useState<Project | null>(null);
  const hide = snapshot.prefs.hideEarnings;
  const { focusProject, clearFocusProject } = nav;

  useEffect(() => {
    if (focusProject) clearFocusProject();
  }, [focusProject, clearFocusProject]);

  const counts = useMemo(() => {
    const m = new Map<string, number>();
    for (const t of snapshot.tasks) m.set(t.projectId, (m.get(t.projectId) ?? 0) + 1);
    return m;
  }, [snapshot.tasks]);

  const active = snapshot.projects.filter((p) => !p.archived);
  const archived = snapshot.projects.filter((p) => p.archived);

  const row = (p: Project) => {
    const rate = rateAt(snapshot.rates, p.id, nowSec);
    const n = counts.get(p.id) ?? 0;
    return (
      <li key={p.id} className="project-row">
        <div className="project-line">
          <Swatch color={p.color} />
          <div className="project-title">
            <h3>{p.name}</h3>
            <div className="project-sub">
              {p.billable ? (
                p.billingType === 'fixedFee' ? (
                  <>
                    <span className="tabular fee-line">{feeText(p, hide ? MASK : null)}</span>
                    {rate && rate.rateCents !== null && <span className="muted tabular">Measured at {rateText(rate, hide ? MASK : null)}</span>}
                    {effectiveRateText(p, hide ? MASK : null) && <span className="tabular">{effectiveRateText(p, hide ? MASK : null)}</span>}
                  </>
                ) : rate && rate.rateCents !== null ? (
                  <span className="tabular">{rateText(rate, hide ? MASK : null)}</span>
                ) : (
                  <span className="no-rate">
                    No rate set{' '}
                    <button type="button" className="link" onClick={() => setEditing(p.id)}>
                      Set a rate
                    </button>
                  </span>
                )
              ) : (
                <Badge>Non-billable</Badge>
              )}
              <span className="muted">
                {n} {n === 1 ? 'task' : 'tasks'}
              </span>
              {p.budgetHours !== null && <span className="muted">Budget {p.budgetHours} h</span>}
              {p.clientZone && <span className="muted">Client zone {p.clientZone.split('/').pop()?.replaceAll('_', ' ')}</span>}
              {p.archived && <Badge tone="warning">Archived</Badge>}
            </div>
            <BudgetMeter project={p} hideEarnings={hide} onSetRate={() => setEditing(p.id)} />
          </div>
          <div className="project-actions">
            <Button small icon={<IconEdit />} aria-expanded={editing === p.id} onClick={() => setEditing(editing === p.id ? null : p.id)}>
              Edit <span className="visually-hidden">{p.name}</span>
            </Button>
            {p.archived ? (
              <Button small icon={<IconRestore />} onClick={() => void act(() => api.setProjectArchived(p.id, false))}>
                Restore <span className="visually-hidden">{p.name}</span>
              </Button>
            ) : p.hasTasks ? (
              <Button small icon={<IconArchive />} onClick={() => void act(() => api.setProjectArchived(p.id, true))}>
                Archive <span className="visually-hidden">{p.name}</span>
              </Button>
            ) : (
              <Button small variant="danger" icon={<IconTrash />} onClick={() => setDeleting(p)}>
                Delete <span className="visually-hidden">{p.name}</span>
              </Button>
            )}
          </div>
        </div>
        {editing === p.id && (
          <div className="project-edit">
            <ProjectForm project={p} onDone={() => setEditing(null)} />
          </div>
        )}
      </li>
    );
  };

  return (
    <div className="page" role="region" aria-label="Projects">
      <div className="page-head">
        <h2>Projects</h2>
        <Button variant="primary" icon={<IconPlus />} aria-expanded={creating} onClick={() => setCreating((v) => !v)}>
          New project
        </Button>
      </div>
      {creating && (
        <Card className="page-card" label="New project">
          <ProjectForm onDone={() => setCreating(false)} />
        </Card>
      )}
      {snapshot.projects.length === 0 && !creating && <p className="muted empty">No projects yet. Create one to start adding tasks. A project holds a colour, an optional hourly price and its rounding.</p>}
      {active.length > 0 && (
        <Card className="page-card" label="Active projects">
          <ul className="project-list">{active.map(row)}</ul>
        </Card>
      )}
      {archived.length > 0 && (
        <Card className="page-card" label="Archived projects">
          <h3 className="section-title">Archived</h3>
          <ul className="project-list">{archived.map(row)}</ul>
        </Card>
      )}
      <Modal
        open={deleting !== null}
        title="Delete this project?"
        onClose={() => setDeleting(null)}
        footer={
          <>
            <Button onClick={() => setDeleting(null)}>Keep it</Button>
            <Button
              variant="danger"
              onClick={() => {
                const p = deleting;
                setDeleting(null);
                if (p) void act(() => api.deleteProject(p.id));
              }}
            >
              Delete project
            </Button>
          </>
        }
      >
        <p>“{deleting?.name}” has no tasks. Deleting it also removes its price history.</p>
      </Modal>
    </div>
  );
}
