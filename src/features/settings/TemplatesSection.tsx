// Templates: list, create from scratch, edit, delete. (Using one is on the new-task form; "Save as
// template" is on a task.) A template's task-list items are saved unticked by the backend.
import { useEffect, useRef, useState, type FormEvent } from 'react';

import { useAppState } from '../../app/store';
import { useReadOnly } from '../../app/useReadOnly';
import { api } from '../../lib/api';
import { errorCode, errorMessage } from '../../lib/errorMessage';
import type { RichDoc, Template } from '../../lib/types';
import { useDirtyGuard } from '../../components/dirtyGuard';
import { IconEdit, IconPlus, IconTrash } from '../../components/icons';
import { RichEditor } from '../../components/RichText';
import { Button, ConfirmDialog, Field, ProjectChip } from '../../components/ui';
import { useCommands } from '../../components/useCommands';
import { ReadOnlyNote } from './ReadOnlyNote';
import { MAX_TEMPLATE_NAME, MAX_TEMPLATE_TAGS, liveTagIds, templatePreview, validateTemplateName } from './templateLogic';
import './catalog.css';

function TemplateEditor({ template, onDone }: { template: Template | null; onDone: () => void }) {
  const { snapshot, adopt } = useAppState();
  const { readOnly } = useReadOnly();
  const [name, setName] = useState(template?.name ?? '');
  const [projectId, setProjectId] = useState<string | null>(template?.projectId ?? null);
  const [tags, setTags] = useState<string[]>(() => liveTagIds(template ?? { tags: [] }, new Set(snapshot.tags.map((t) => t.id))));
  const [text, setText] = useState<RichDoc>(template?.description ?? null);
  // What the editor opened with: leaving the tab asks first only if something differs from it.
  const [opened] = useState({ name, projectId, tags, text });
  useDirtyGuard(
    name !== opened.name ||
      projectId !== opened.projectId ||
      tags.length !== opened.tags.length ||
      tags.some((id) => !opened.tags.includes(id)) ||
      (text !== opened.text && JSON.stringify(text) !== JSON.stringify(opened.text)),
  );
  const [touched, setTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const [refusal, setRefusal] = useState<{ code: string; message: string } | null>(null);
  // The editor opens with the cursor in the name. (`data-autofocus` only works inside a Modal.)
  const nameInput = useRef<HTMLInputElement | null>(null);
  useEffect(() => {
    nameInput.current?.focus();
  }, []);

  const nameError = validateTemplateName(name);
  const tooManyTags = tags.length > MAX_TEMPLATE_TAGS ? `A template can have at most ${MAX_TEMPLATE_TAGS} tags.` : null;
  // A project the template points at stays selectable even if it was archived since.
  const projects = snapshot.projects.filter((p) => !p.archived || p.id === projectId);
  const nameRefusal = refusal && /name/i.test(refusal.message) ? refusal.message : null;
  const otherRefusal = refusal && !nameRefusal ? refusal.message : null;

  async function submit(e: FormEvent): Promise<void> {
    e.preventDefault();
    setTouched(true);
    if (nameError || tooManyTags || readOnly) return;
    setBusy(true);
    try {
      const r = await api.saveTemplate({ id: template?.id ?? null, name: name.trim(), projectId, description: text, tags });
      adopt(r.snapshot);
      onDone();
    } catch (err) {
      setRefusal({ code: errorCode(err), message: errorMessage(err) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="template-editor" aria-label={template ? `Edit template ${template.name}` : 'New template'} noValidate onSubmit={(e) => void submit(e)}>
      <Field label="Template name" error={(touched ? nameError : null) ?? nameRefusal} hint={`Up to ${MAX_TEMPLATE_NAME} characters. The task made from it gets this name.`}>
        {({ id, describedBy }) => (
          <input
            id={id}
            className="input"
            value={name}
            onChange={(e) => {
              setName(e.target.value);
              setRefusal(null);
            }}
            aria-required="true"
            aria-invalid={(touched && nameError) || nameRefusal ? true : undefined}
            aria-describedby={describedBy}
            autoComplete="off"
            ref={nameInput}
          />
        )}
      </Field>
      <Field label="Project" hint="Optional. Without one, you choose the project when you use the template.">
        {({ id, describedBy }) => (
          <select id={id} className="input" value={projectId ?? ''} onChange={(e) => setProjectId(e.target.value === '' ? null : e.target.value)} aria-describedby={describedBy}>
            <option value="">No project (choose when used)</option>
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
                {p.archived ? ' (archived)' : ''}
              </option>
            ))}
          </select>
        )}
      </Field>
      <fieldset className="fieldset">
        <legend>Tags</legend>
        {snapshot.tags.length === 0 ? (
          <p className="muted">There are no tags yet. Add some under Tags above.</p>
        ) : (
          <div className="chip-row">
            {snapshot.tags.map((t) => (
              <label key={t.id} className="tag-toggle">
                <input type="checkbox" checked={tags.includes(t.id)} onChange={(e) => setTags((cur) => (e.target.checked ? [...cur, t.id] : cur.filter((x) => x !== t.id)))} />
                <ProjectChip name={t.name} color={t.color} />
              </label>
            ))}
          </div>
        )}
        {tooManyTags && (
          <p className="field-error" role="alert">
            {tooManyTags}
          </p>
        )}
      </fieldset>
      <RichEditor label="Template text" value={text} onChange={setText} hint="A task list is allowed. Its items are always saved unticked, so every task made from the template starts fresh." />
      {otherRefusal && (
        <p className="form-error" role="alert">
          {otherRefusal}
        </p>
      )}
      <div className="form-actions">
        <Button variant="primary" type="submit" disabled={busy || readOnly}>
          {template ? 'Save template' : 'Create template'}
        </Button>
        <Button variant="ghost" onClick={onDone}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

export function TemplatesSection() {
  const { snapshot } = useAppState();
  const { act } = useCommands();
  const { readOnly } = useReadOnly();
  const [editing, setEditing] = useState<string | 'new' | null>(null);
  const [deleting, setDeleting] = useState<Template | null>(null);

  const tagById = new Map(snapshot.tags.map((t) => [t.id, t]));
  const projectById = new Map(snapshot.projects.map((p) => [p.id, p]));
  const closeEditor = (opener: string): void => {
    setEditing(null);
    window.setTimeout(() => document.getElementById(opener)?.focus(), 0);
  };

  return (
    <div className="settings-stack">
      <ReadOnlyNote />
      <p className="muted">A template is a starting point for a task: a name, an optional project, tags and text, including a task list. Use one from “From template” on the new-task form. Items in a task list are always saved unticked.</p>
      {snapshot.templates.length === 0 && <p className="muted">No templates yet.</p>}
      <ul className="template-list" aria-label="Templates">
        {snapshot.templates.map((tpl) => {
          const project = tpl.projectId ? projectById.get(tpl.projectId) : undefined;
          const preview = templatePreview(tpl.description);
          return (
            <li key={tpl.id} className="template-row">
              {editing === tpl.id ? (
                <TemplateEditor key={tpl.id} template={tpl} onDone={() => closeEditor(`template-edit-${tpl.id}`)} />
              ) : (
                <div className="template-line">
                  <div className="template-title">
                    <h4>{tpl.name}</h4>
                    <div className="template-meta">
                      {project ? <ProjectChip name={project.name} color={project.color} archived={project.archived} /> : <span className="muted">No project</span>}
                      {liveTagIds(tpl, new Set(tagById.keys())).map((id) => {
                        const t = tagById.get(id);
                        return t ? <ProjectChip key={id} name={t.name} color={t.color} /> : null;
                      })}
                      {preview.items.length > 0 && (
                        <span className="muted">
                          {preview.items.length} task-list {preview.items.length === 1 ? 'item' : 'items'}: {preview.items.join(', ')}
                        </span>
                      )}
                    </div>
                    {preview.firstLine && <p className="muted template-text">{preview.firstLine}</p>}
                  </div>
                  <span className="template-actions">
                    <Button small id={`template-edit-${tpl.id}`} icon={<IconEdit />} disabled={readOnly} onClick={() => setEditing(tpl.id)}>
                      Edit <span className="visually-hidden">template {tpl.name}</span>
                    </Button>
                    <Button small variant="danger" icon={<IconTrash />} disabled={readOnly} onClick={() => setDeleting(tpl)}>
                      Delete <span className="visually-hidden">template {tpl.name}</span>
                    </Button>
                  </span>
                </div>
              )}
            </li>
          );
        })}
      </ul>
      {editing === 'new' ? (
        <TemplateEditor template={null} onDone={() => closeEditor('template-add')} />
      ) : (
        <div>
          <Button id="template-add" icon={<IconPlus />} disabled={readOnly} onClick={() => setEditing('new')}>
            New template
          </Button>
        </div>
      )}
      <ConfirmDialog
        open={deleting !== null}
        title="Delete this template?"
        confirmLabel="Delete template"
        cancelLabel="Keep it"
        danger
        onCancel={() => setDeleting(null)}
        onConfirm={() => {
          const t = deleting;
          setDeleting(null);
          if (t) void act(() => api.deleteTemplate(t.id));
        }}
      >
        <p>“{deleting?.name}” is removed from the list. Tasks already made from it are not changed.</p>
      </ConfirmDialog>
    </div>
  );
}
