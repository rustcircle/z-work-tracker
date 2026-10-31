// Manage tags: list, add, rename, recolour with the picker, delete.
import { useEffect, useRef, useState, type FormEvent } from 'react';

import { useAppState } from '../../app/store';
import { api } from '../../lib/api';
import { normalizeHex, suggestColor } from '../../lib/color';
import { errorCode, errorMessage } from '../../lib/errorMessage';
import { rememberColor } from '../../lib/recentColors';
import type { Tag } from '../../lib/types';
import { ColorPicker } from '../../components/ColorPicker';
import { useColorNotices } from '../../components/colorNotice';
import { useOptionalNav } from '../../components/nav';
import { IconEdit, IconPlus, IconTrash } from '../../components/icons';
import { Button, ConfirmDialog, Field, ProjectChip } from '../../components/ui';
import { useCommands } from '../../components/useCommands';
import './catalog.css';

export const MAX_TAG_NAME = 40;

/** The name rules the backend applies, plus a clash check against the other tags (ignoring case). */
export function validateTagName(name: string, tags: readonly Tag[], exceptId: string | null): string | null {
  const n = name.trim();
  if (n === '') return 'Enter a tag name.';
  if ([...n].length > MAX_TAG_NAME) return `A tag name can have at most ${MAX_TAG_NAME} characters.`;
  if (tags.some((t) => t.id !== exceptId && !t.deleted && t.name.trim().toLowerCase() === n.toLowerCase())) return `A tag named “${n}” already exists.`;
  return null;
}

function TagEditor({ tag, onDone }: { tag: Tag | null; onDone: (savedId: string | null) => void }) {
  const { snapshot, adopt } = useAppState();
  const notices = useColorNotices();
  const colorRef = useRef<HTMLDivElement | null>(null);
  const nav = useOptionalNav();
  const [name, setName] = useState(tag?.name ?? '');
  const [color, setColor] = useState(tag?.color ?? suggestColor(snapshot.tags.map((t) => t.color)));
  const [touched, setTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const [refusal, setRefusal] = useState<{ code: string; message: string } | null>(null);
  // The editor opens with the cursor in the name. (`data-autofocus` only works inside a Modal.)
  const nameInput = useRef<HTMLInputElement | null>(null);
  // "Choose again" on the replaced-colour notice opens this editor with the cursor in the colour choice.
  const chosen = nav?.colorTarget?.kind === 'tag' && tag !== null && nav.colorTarget.id === tag.id;
  const clearColorTarget = nav?.clearColorTarget;
  useEffect(() => {
    if (chosen) {
      colorRef.current?.querySelector<HTMLElement>('[role="radio"][tabindex="0"], input, button')?.focus();
      clearColorTarget?.();
    } else nameInput.current?.focus();
    // Focus once, when the editor opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const nameError = validateTagName(name, snapshot.tags, tag?.id ?? null);
  const others = snapshot.tags.filter((t) => t.id !== tag?.id).map((t) => ({ name: t.name, color: t.color }));
  // The backend's refusal goes where it belongs: a clash by the name, a colour complaint by the picker.
  const nameRefusal = refusal && (refusal.code === 'conflict' || /name/i.test(refusal.message)) ? refusal.message : null;
  const colorRefusal = refusal && !nameRefusal && /colou?r/i.test(refusal.message) ? refusal.message : null;
  const otherRefusal = refusal && !nameRefusal && !colorRefusal ? refusal.message : null;

  async function submit(e: FormEvent): Promise<void> {
    e.preventDefault();
    setTouched(true);
    if (nameError) return;
    const hex = normalizeHex(color) ?? color;
    setBusy(true);
    try {
      const r = await api.saveTag({ id: tag?.id ?? null, name: name.trim(), color: hex });
      adopt(r.snapshot);
      rememberColor(r.color || hex);
      if (r.replacedFrom) notices.report({ kind: 'tag', itemId: r.id, name: name.trim(), asked: r.replacedFrom, got: r.color });
      else notices.dismissFor('tag', r.id);
      onDone(r.id);
    } catch (err) {
      setRefusal({ code: errorCode(err), message: errorMessage(err) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="tag-editor" aria-label={tag ? `Edit tag ${tag.name}` : 'New tag'} noValidate onSubmit={(e) => void submit(e)}>
      <Field label="Tag name" error={(touched ? nameError : null) ?? nameRefusal} hint={`Up to ${MAX_TAG_NAME} characters.`}>
        {({ id, describedBy }) => (
          <input
            id={id}
            className="input"
            value={name}
            onChange={(e) => {
              setName(e.target.value);
              setRefusal(null);
            }}
            maxLength={MAX_TAG_NAME * 2}
            aria-required="true"
            aria-invalid={(touched && nameError) || nameRefusal ? true : undefined}
            aria-describedby={describedBy}
            autoComplete="off"
            ref={nameInput}
          />
        )}
      </Field>
      <div ref={colorRef}>
      <ColorPicker
        label="Tag colour"
        value={normalizeHex(color) ?? color}
        onChange={(c) => {
          setColor(c);
          setRefusal(null);
        }}
        sampleName={name.trim() || 'Tag name'}
        neighbours={others}
        neighbourNoun="tag"
        theme={snapshot.prefs.theme}
        error={colorRefusal}
      />
      </div>
      {otherRefusal && (
        <p className="form-error" role="alert">
          {otherRefusal}
        </p>
      )}
      <div className="form-actions">
        <Button variant="primary" type="submit" disabled={busy}>
          {tag ? 'Save tag' : 'Add tag'}
        </Button>
        <Button variant="ghost" onClick={() => onDone(null)}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

export function TagsSection() {
  const { snapshot } = useAppState();
  const { act } = useCommands();
  const nav = useOptionalNav();
  // "New tag" next to a tag picker opens this section with the Add tag form already open; "Choose again" opens one tag.
  const [editing, setEditing] = useState<string | 'new' | null>(() => (nav?.tagIntent && nav.tagIntent.createdId === null ? 'new' : nav?.colorTarget?.kind === 'tag' ? nav.colorTarget.id : null));
  const intent = nav?.tagIntent ?? null;
  const intentOpen = intent !== null && intent.createdId === null;
  const colorTag = nav?.colorTarget?.kind === 'tag' ? nav.colorTarget.id : null;
  // A request arriving while this section is already open (the rail is visible on every tab): follow it.
  const [seen, setSeen] = useState({ intentOpen, colorTag });
  if (seen.intentOpen !== intentOpen || seen.colorTag !== colorTag) {
    setSeen({ intentOpen, colorTag });
    if (intentOpen && !seen.intentOpen) setEditing('new');
    else if (colorTag && colorTag !== seen.colorTag) setEditing(colorTag);
  }
  const [deleting, setDeleting] = useState<Tag | null>(null);

  const uses = (id: string): number => snapshot.tasks.filter((t) => t.tags.includes(id)).length;
  // Focus goes back to the button that opened the editor.
  const closeEditor = (opener: string): void => {
    setEditing(null);
    window.setTimeout(() => document.getElementById(opener)?.focus(), 0);
  };

  return (
    <div className="settings-stack">
      <p className="muted">
        Tags label what kind of work a task is. A task can have several, and a task with two tags counts fully in each. While at least one tag exists, a task needs a tag before its first start after launch.
      </p>
      {snapshot.tags.length === 0 && <p className="muted">No tags yet. Add one to label your tasks.</p>}
      <ul className="tag-list" aria-label="Tags">
        {snapshot.tags.map((t) => (
          <li key={t.id} className="tag-row">
            {editing === t.id ? (
              <TagEditor tag={t} onDone={() => closeEditor(`tag-edit-${t.id}`)} />
            ) : (
              <div className="tag-line">
                <ProjectChip name={t.name} color={t.color} />
                <code className="swatch-hex">{t.color}</code>
                <span className="muted">
                  {uses(t.id)} {uses(t.id) === 1 ? 'task' : 'tasks'}
                </span>
                <span className="tag-actions">
                  <Button small id={`tag-edit-${t.id}`} icon={<IconEdit />} onClick={() => setEditing(t.id)}>
                    Edit <span className="visually-hidden">tag {t.name}</span>
                  </Button>
                  <Button small variant="danger" icon={<IconTrash />} onClick={() => setDeleting(t)}>
                    Delete <span className="visually-hidden">tag {t.name}</span>
                  </Button>
                </span>
              </div>
            )}
          </li>
        ))}
      </ul>
      {editing === 'new' ? (
        <TagEditor
          tag={null}
          onDone={(savedId) => {
            if (intent && savedId) {
              // Made for a task: the picker selects it on return, so the required-tag rule is met.
              nav?.tagCreated(savedId);
              setEditing(null);
              window.setTimeout(() => document.getElementById('back-to-task')?.focus(), 0);
            } else closeEditor('tag-add');
          }}
        />
      ) : (
        <div>
          <Button id="tag-add" icon={<IconPlus />} onClick={() => setEditing('new')}>
            Add tag
          </Button>
        </div>
      )}
      <ConfirmDialog
        open={deleting !== null}
        title="Delete this tag?"
        confirmLabel="Delete tag"
        cancelLabel="Keep it"
        danger
        onCancel={() => setDeleting(null)}
        onConfirm={() => {
          const t = deleting;
          setDeleting(null);
          if (t) void act(() => api.deleteTag(t.id));
        }}
      >
        <p>
          “{deleting?.name}” is removed from the list
          {deleting && uses(deleting.id) > 0 ? ` and from the ${uses(deleting.id)} ${uses(deleting.id) === 1 ? 'task' : 'tasks'} that have it` : ''}. Tasks keep no tag of that name afterwards. The tasks and their logged time stay as they are.
        </p>
      </ConfirmDialog>
    </div>
  );
}
