// Tags on a task: a read-only chip (name always printed, colour from the tag, text colour computed)
// and a multi-select of the live tags for the new-task form and the inline editor.
import { useEffect, useEffectEvent, useId, useRef } from 'react';

import { readableText } from '../../lib/color';
import type { Tag } from '../../lib/types';
import { Button } from '../../components/ui';
import { IconPlus } from '../../components/icons';
import { useOptionalNav } from '../../components/nav';
import './tasksP2.css';

export function TagChip({ tag }: { tag: Pick<Tag, 'name' | 'color'> }) {
  return (
    <span className="tag-chip" style={{ background: tag.color, color: readableText(tag.color) }} data-testid="tag-chip">
      <span className="tag-chip-name">{tag.name}</span>
    </span>
  );
}

/** The chips of the tags a task has, skipping ids that are deleted or unknown. */
export function TagChips({ ids, tags }: { ids: readonly string[]; tags: readonly Tag[] }) {
  const own = ids.map((id) => tags.find((t) => t.id === id && !t.deleted)).filter((t): t is Tag => t !== undefined);
  if (own.length === 0) return null;
  return (
    <ul className="tag-chips" aria-label="Tags">
      {own.map((t) => (
        <li key={t.id}>
          <TagChip tag={t} />
        </li>
      ))}
    </ul>
  );
}

interface PickerProps {
  /** Every live tag, in the backend's order. */
  tags: readonly Tag[];
  /** Ids of the chosen tags. */
  value: readonly string[];
  onChange: (ids: string[]) => void;
  error?: string | null;
  hint?: string;
  /** The group's name. */
  legend?: string;
}

/** A group of checkboxes drawn as chips: a chosen tag is filled with its colour, a free one is outlined. */
export function TagPicker({ tags, value, onChange, error = null, hint, legend = 'Tags' }: PickerProps) {
  const id = useId();
  const nav = useOptionalNav();
  const box = useRef<HTMLFieldSetElement | null>(null);
  const live = tags.filter((t) => !t.deleted);
  const chosen = new Set(value);
  const intent = nav?.tagIntent ?? null;
  // Coming back from Settings with a tag made for this picker: tick it, so a required tag is satisfied.
  const created = intent && intent.origin === id ? intent.createdId : null;
  const { returnFocus, clearReturnFocus } = nav ?? {};
  const tickCreated = useEffectEvent((tagId: string) => {
    if (!live.some((t) => t.id === tagId)) return;
    if (!value.includes(tagId)) onChange([...live.filter((t) => value.includes(t.id)).map((t) => t.id), tagId]);
  });
  const createdLive = created !== null && live.some((t) => t.id === created);
  // Ticked once per created tag: the user may untick it afterwards and it stays unticked. The notice with the way
  // back stays up until it is taken, so this must not end the errand.
  const tickedFor = useRef<string | null>(null);
  useEffect(() => {
    if (!created || !createdLive || tickedFor.current === created) return;
    tickedFor.current = created;
    tickCreated(created);
  }, [created, createdLive]);
  // After "Back to task", the cursor returns to this picker.
  useEffect(() => {
    if (returnFocus !== id) return;
    box.current?.querySelector<HTMLElement>('input, button')?.focus();
    clearReturnFocus?.();
  }, [returnFocus, id, clearReturnFocus]);
  const toggle = (tagId: string, on: boolean): void => {
    // Ids of tags that were deleted meanwhile are dropped, so a save never sends one.
    const next = live.filter((t) => (t.id === tagId ? on : chosen.has(t.id))).map((t) => t.id);
    onChange(next);
  };
  const hintId = `${id}-hint`;
  const errId = `${id}-err`;
  const describedBy = [hint && live.length > 0 ? hintId : '', error ? errId : ''].filter(Boolean).join(' ') || undefined;
  return (
    <fieldset className="field tag-picker" aria-describedby={describedBy} ref={box}>
      <legend className="field-label">{legend}</legend>
      {live.length === 0 ? (
        <p className="field-hint">
          No tags yet.{' '}
          Use New tag below to add one.
        </p>
      ) : (
        <ul className="tag-options">
          {live.map((t) => {
            const on = chosen.has(t.id);
            return (
              <li key={t.id}>
                <label className={`tag-option${on ? ' tag-option-on' : ''}`} style={on ? { background: t.color, color: readableText(t.color) } : undefined}>
                  <input type="checkbox" className="tag-option-box" checked={on} onChange={(e) => toggle(t.id, e.target.checked)} />
                  <span className="tag-dot" style={{ background: t.color }} aria-hidden="true" />
                  <span className="tag-chip-name">{t.name}</span>
                  {on && <span className="tag-tick" aria-hidden="true">✓</span>}
                </label>
              </li>
            );
          })}
        </ul>
      )}
      {nav && (
        <div className="tag-new">
          <Button small icon={<IconPlus />} onClick={() => nav.startNewTag(id)}>
            New tag
          </Button>
        </div>
      )}
      {live.length > 0 && hint && (
        <p className="field-hint" id={hintId}>
          {hint}
        </p>
      )}
      {error && (
        <p className="field-error" role="alert" id={errId}>
          {error}
        </p>
      )}
    </fieldset>
  );
}
