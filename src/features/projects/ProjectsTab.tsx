import { useEffect, useMemo, useState } from 'react';

import { projectsAt } from '../../lib/liveFigures';

import { useApp } from '../../app/store';
import { useReadOnly } from '../../app/useReadOnly';
import { api } from '../../lib/api';
import { MASK } from '../../lib/billing';
import type { Project } from '../../lib/types';
import { useLeaveCheck } from '../../components/dirtyGuard';
import { useNav } from '../../components/nav';
import { Badge, Button, Card, Modal, Swatch } from '../../components/ui';
import { IconArchive, IconEdit, IconPlus, IconRestore, IconTrash } from '../../components/icons';
import { useCommands } from '../../components/useCommands';
import { BudgetMeter } from './BudgetMeter';
import { ProjectForm } from './ProjectForm';
import { effectiveRateText, feeText, rateAt, rateText } from './projectLogic';

/** Showing the editor of `id` would take the place of one that has changes that are not saved. */
const replacesChanges = (editing: string | null, dirty: boolean, id: string): boolean => editing !== null && id !== editing && dirty;

export function ProjectsTab() {
  const { snapshot, nowSec } = useApp();
  const nav = useNav();
  const { act } = useCommands();
  const ro = useReadOnly();
  const leave = useLeaveCheck();
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<string | null>(nav.focusProject);
  // Whether the form that is open has changes that are not saved: the New project form, and the editor of a project. A form is lost when
  // it is closed, when another project's editor takes its place, and when its project moves to the other list (the row is rebuilt).
  // Each of those asks first, but only when it is this form that would be lost, not for changes in another one.
  const [createDirty, setCreateDirty] = useState(false);
  const [editorDirty, setEditorDirty] = useState(false);
  const [deleting, setDeleting] = useState<Project | null>(null);
  const hide = snapshot.prefs.hideEarnings;
  const { focusProject, clearFocusProject, colorTarget, clearColorTarget, chooseColor } = nav;

  /** Shows the editor of a project. One with changes that are not saved is only replaced once the user agrees. */
  const openEditor = (id: string): void => {
    if (replacesChanges(editing, editorDirty, id)) leave(() => setEditing(id));
    else setEditing(id);
  };
  /** Closes the editor that is open, once the user agrees when it has changes that are not saved. Cancel in the form is the one that does not ask. */
  const closeEditor = (): void => {
    if (editorDirty) leave(() => setEditing(null));
    else setEditing(null);
  };
  /** The New project button opens the form, and closes it again, once the user agrees when it has changes that are not saved. */
  const toggleCreating = (): void => {
    if (!creating) setCreating(true);
    else if (createDirty) leave(() => setCreating(false));
    else setCreating(false);
  };
  /** Archives or restores a project. Its row moves to the other list, which rebuilds an editor open on it, so changes in that editor ask first. */
  const setArchived = (p: Project, archived: boolean): void => {
    const go = (): void => void act(() => api.setProjectArchived(p.id, archived));
    if (editing === p.id && editorDirty) leave(go);
    else go();
  };

  // The ticker's "Set a rate" and the replaced-colour notice ask for a project's editor, also while this tab is the one shown (the form
  // then takes the focus, for the colour notice). The editor opens as the request comes, as the replaced-colour one always did, unless it
  // would replace changes that are not saved: then the question is asked once the request has been taken, so it does not outlive the answer.
  const [seenFocus, setSeenFocus] = useState(focusProject);
  if (seenFocus !== focusProject) {
    setSeenFocus(focusProject);
    if (focusProject && !replacesChanges(editing, editorDirty, focusProject)) setEditing(focusProject);
  }
  useEffect(() => {
    if (!focusProject) return;
    clearFocusProject();
    if (!replacesChanges(editing, editorDirty, focusProject)) return;
    // The colour request goes with the answer too: it is made again once the user agrees. With Keep editing it would otherwise stay,
    // and move the cursor into the form the next time that project's editor is opened by hand.
    const colour = colorTarget?.kind === 'project' && colorTarget.id === focusProject;
    if (colour) clearColorTarget();
    leave(() => {
      setEditing(focusProject);
      if (colour) chooseColor('project', focusProject);
    });
  }, [focusProject, clearFocusProject, colorTarget, clearColorTarget, chooseColor, editing, editorDirty, leave]);

  const counts = useMemo(() => {
    const m = new Map<string, number>();
    for (const t of snapshot.tasks) m.set(t.projectId, (m.get(t.projectId) ?? 0) + 1);
    return m;
  }, [snapshot.tasks]);

  // Budgets count a running task's time: `nowSec` moves once a minute, and no new snapshot does.
  const projects = useMemo(() => projectsAt(snapshot, nowSec), [snapshot, nowSec]);
  const active = projects.filter((p) => !p.archived);
  const archived = projects.filter((p) => p.archived);

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
                    <button type="button" className="link" onClick={() => openEditor(p.id)}>
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
            <BudgetMeter project={p} hideEarnings={hide} onSetRate={() => openEditor(p.id)} />
          </div>
          <div className="project-actions">
            <Button small icon={<IconEdit />} aria-expanded={editing === p.id} onClick={() => (editing === p.id ? closeEditor() : openEditor(p.id))}>
              Edit <span className="visually-hidden">{p.name}</span>
            </Button>
            {p.archived ? (
              <Button small icon={<IconRestore />} disabled={ro.readOnly} title={ro.why ?? undefined} onClick={() => setArchived(p, false)}>
                Restore <span className="visually-hidden">{p.name}</span>
              </Button>
            ) : p.hasTasks ? (
              <Button small icon={<IconArchive />} disabled={ro.readOnly} title={ro.why ?? undefined} onClick={() => setArchived(p, true)}>
                Archive <span className="visually-hidden">{p.name}</span>
              </Button>
            ) : (
              <Button small variant="danger" icon={<IconTrash />} disabled={ro.readOnly} title={ro.why ?? undefined} onClick={() => setDeleting(p)}>
                Delete <span className="visually-hidden">{p.name}</span>
              </Button>
            )}
          </div>
        </div>
        {editing === p.id && (
          <div className="project-edit">
            <ProjectForm project={p} onDone={() => setEditing(null)} onDirtyChange={setEditorDirty} />
          </div>
        )}
      </li>
    );
  };

  return (
    <div className="page" role="region" aria-label="Projects">
      <div className="page-head">
        <h2>Projects</h2>
        {/* A form already open stays open, and keeps what is typed in it, so it closes with its own Cancel. */}
        <Button variant="primary" icon={<IconPlus />} aria-expanded={creating} disabled={ro.readOnly && !creating} title={ro.readOnly && !creating ? (ro.why ?? undefined) : undefined} onClick={toggleCreating}>
          New project
        </Button>
      </div>
      {creating && (
        <Card className="page-card" label="New project">
          <ProjectForm onDone={() => setCreating(false)} onDirtyChange={setCreateDirty} />
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
              disabled={ro.readOnly}
              title={ro.why ?? undefined}
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
        {ro.readOnly && <p className="muted">{ro.why}</p>}
      </Modal>
    </div>
  );
}
