import { useMemo, useState, type FormEvent } from 'react';

import { useApp } from '../../app/store';
import { api } from '../../lib/api';
import type { RichDoc, Task } from '../../lib/types';
import { RichEditor } from '../../components/RichText';
import { Button, Field } from '../../components/ui';
import { IconPlay } from '../../components/icons';
import { useCommands } from '../../components/useCommands';
import { validateTask } from './taskLogic';

/** Create a task, or edit one. Start stays disabled until the name and project are valid. */
export function TaskForm({ task, onDone }: { task?: Task; onDone: () => void }) {
  const { snapshot } = useApp();
  const { act, transition } = useCommands();
  const [name, setName] = useState(task?.name ?? '');
  const [projectId, setProjectId] = useState(task?.projectId ?? '');
  const [description, setDescription] = useState<RichDoc>(task?.description ?? null);
  const [touched, setTouched] = useState(false);
  const [busy, setBusy] = useState(false);

  const usable = useMemo(() => snapshot.projects.filter((p) => !p.archived || p.id === task?.projectId), [snapshot.projects, task?.projectId]);
  const errors = validateTask({ name, projectId, description }, snapshot.projects, task?.projectId ?? null);
  const showErrors = touched;
  const missing = [errors.name ? 'a task name' : null, errors.project ? 'a project' : null].filter(Boolean).join(' and ');

  const input = { name: name.trim(), projectId, description };

  async function save(startAfter: boolean): Promise<void> {
    setTouched(true);
    if (!errors.ok) return;
    setBusy(true);
    try {
      if (task) {
        if (await act(() => api.updateTask(task.id, input))) onDone();
        return;
      }
      let id: string | null = null;
      const created = await act(async () => {
        const r = await api.createTask(input);
        id = r.id;
        return r.snapshot;
      });
      if (!created || id === null) return;
      if (startAfter) {
        const started = id;
        await transition(() => api.startTask(started), input.name);
      }
      onDone();
    } finally {
      setBusy(false);
    }
  }

  function onSubmit(e: FormEvent): void {
    e.preventDefault();
    void save(false);
  }

  return (
    <form className="task-form" onSubmit={onSubmit} noValidate aria-label={task ? 'Edit task' : 'New task'}>
      <Field label="Task name" error={showErrors ? errors.name : null}>
        {({ id, describedBy }) => <input id={id} className="input" value={name} onChange={(e) => setName(e.target.value)} onBlur={() => setTouched(true)} aria-required="true" aria-invalid={showErrors && errors.name ? true : undefined} aria-describedby={describedBy} autoComplete="off" data-autofocus />}
      </Field>
      <Field label="Project" error={showErrors ? errors.project : null} hint={usable.length === 0 ? 'No projects yet. Create one in the Projects tab first.' : undefined}>
        {({ id, describedBy }) => (
          <select id={id} className="input" value={projectId} onChange={(e) => setProjectId(e.target.value)} onBlur={() => setTouched(true)} aria-required="true" aria-invalid={showErrors && errors.project ? true : undefined} aria-describedby={describedBy}>
            <option value="">Choose a project</option>
            {usable.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
                {p.archived ? ' (archived)' : ''}
              </option>
            ))}
          </select>
        )}
      </Field>
      <RichEditor label="Description" value={description} onChange={setDescription} />
      {!errors.ok && !task && (
        <p className="validation-note" id="start-needs">
          To start, enter {missing}.
        </p>
      )}
      <div className="form-actions">
        {task ? (
          <>
            <Button variant="primary" type="submit" disabled={busy}>
              Save changes
            </Button>
            <Button onClick={onDone}>Cancel</Button>
          </>
        ) : (
          <>
            <Button type="submit" disabled={busy}>
              Save draft
            </Button>
            <Button variant="primary" icon={<IconPlay />} disabled={!errors.ok || busy} aria-describedby={!errors.ok ? 'start-needs' : undefined} onClick={() => void save(true)}>
              Start
            </Button>
            <Button variant="ghost" onClick={onDone}>
              Cancel
            </Button>
          </>
        )}
      </div>
    </form>
  );
}
