// The tags of one subtask on the task card: a small button that says what the item's time counts under, and a checklist
// that changes it. An item counts under its task's tags ("Same as task", the default) or under some of them, and none
// ticked is "No tag". Every change is saved at once, one after the other, each from what the one before left, with what
// the row showed as the value to compare with, so a stale view never overwrites another computer's newer choice: the
// backend refuses with `conflict`, nothing is written, and the row says so and shows what is stored. A change that fails or
// is refused drops the ones queued behind it, which were worked out from a state the store never reached.
import { useEffect, useId, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';

import { useAppState } from '../../app/store';
import type { ReadOnly } from '../../app/useReadOnly';
import { IconChevron, IconTag } from '../../components/icons';
import { Button } from '../../components/ui';
import { api } from '../../lib/api';
import { readableText } from '../../lib/color';
import { errorMessage } from '../../lib/errorMessage';
import { effectiveTags, sameOverride } from '../../lib/subtasks';
import type { Tag } from '../../lib/types';
import './tasksP2.css';

/** The words of the control, in one place for the tests and the guide. */
export const SAME_AS_TASK = 'Same as task';
export const NO_TAG_TEXT = 'No tag';
export const SELECT_ALL = 'Select all';
export const DESELECT_ALL = 'Deselect all';
export const CONFLICT_NOTE = 'The tags of this item changed since you last looked, so nothing was saved. The list shows the tags it has now.';
const HINT = "This item's time counts under the ticked tags.";

/** The list after one tag is ticked or unticked, as the task's tags in the task's order. Unticking the last one is "No tag". */
export function toggled(live: readonly string[], shown: readonly string[] | null, id: string): string[] {
  const on = new Set(effectiveTags(live, shown));
  if (!on.delete(id)) on.add(id);
  return live.filter((t) => on.has(t));
}

/**
 * What the one button does: everything is ticked, so it unticks all (No tag), or something is not, so it ticks all. Ticking
 * all is a list of every tag and not "Same as task": the item then keeps those tags if the task is given another later.
 */
export function allToggled(live: readonly string[], shown: readonly string[] | null): string[] {
  return effectiveTags(live, shown).length === live.length ? [] : [...live];
}

/** What the button says in words, for a screen reader. */
function summaryOf(shown: readonly string[] | null, on: readonly Tag[]): string {
  if (shown === null) return SAME_AS_TASK;
  return on.length === 0 ? NO_TAG_TEXT : on.map((t) => t.name).join(', ');
}

interface Props {
  taskId: string;
  /** The item: its id, its words (for names), and the tags it shows now. */
  item: { id: string; text: string; tags: string[] | null };
  /** The task's tags that exist, in the task's order: what can be ticked. */
  tags: readonly Tag[];
  ro: ReadOnly;
}

/** What is being asked for while saves are on their way: the row shows it, and the next change starts from it. */
interface Intent {
  tags: string[] | null;
}

export function SubtaskTags({ taskId, item, tags, ro }: Props) {
  const { adopt, showError } = useAppState();
  const popId = useId();
  const rootRef = useRef<HTMLDivElement | null>(null);
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const popRef = useRef<HTMLDivElement | null>(null);
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [intent, setIntent] = useState<Intent | null>(null);
  // The same as `intent`, but readable by a second change that lands before the first has been drawn.
  const latest = useRef<Intent | null>(null);
  const queue = useRef<Promise<void>>(Promise.resolve());
  const pending = useRef(0);
  // Counts the times a change failed or was refused: a queued change from before one is not sent.
  const epoch = useRef(0);
  // Whether focus is in the control, to give it somewhere to go if the list closes under it.
  const focused = useRef(false);

  // Another computer took over while the list was open: nothing in it can be changed now.
  if (open && ro.readOnly) setOpen(false);

  const live = tags.map((t) => t.id);
  const shown = intent ? intent.tags : item.tags;
  // What is ticked is what the item's time counts under: its own list, or every tag of the task while it is on "Same as task".
  const ticked = new Set(effectiveTags(live, shown));
  const on = tags.filter((t) => ticked.has(t.id));
  const name = item.text.trim() === '' ? 'Untitled item' : item.text.trim();
  const allOn = on.length === tags.length;

  /**
   * Asks for a change. `from` is what the row showed, or what the change before it asked for, which is what the store holds
   * once that one has gone through. Changes go out one at a time, so none is worked out from a view the one before has outdated.
   */
  const choose = (change: (from: string[] | null) => string[] | null): void => {
    if (ro.readOnly) return;
    const from = latest.current ? latest.current.tags : item.tags;
    const next = change(from);
    if (sameOverride(from, next)) return;
    const mine = epoch.current;
    latest.current = { tags: next };
    setIntent(latest.current);
    setNote(null);
    pending.current += 1;
    /** What is queued was asked for from what an earlier change would have left: with that gone, the row shows what is stored again. */
    const drop = (): void => {
      epoch.current += 1;
      latest.current = null;
      setIntent(null);
    };
    queue.current = queue.current.then(async () => {
      try {
        if (mine !== epoch.current) return;
        const reply = await api.setSubtaskTags(taskId, item.id, next, { tags: from });
        adopt(reply.snapshot);
        if (reply.conflict) {
          setNote(CONFLICT_NOTE);
          drop();
        }
      } catch (e) {
        showError(errorMessage(e));
        drop();
      } finally {
        pending.current -= 1;
        // With nothing left on its way the row follows the store again.
        if (pending.current === 0) {
          latest.current = null;
          setIntent(null);
        }
      }
    });
  };

  const close = (giveFocusBack: boolean): void => {
    setOpen(false);
    if (giveFocusBack) buttonRef.current?.focus();
  };

  // Another computer took the lease while focus was in the control: the list is gone and the button is off, so focus goes to the
  // item's row, which can hold it, and not to the page.
  useEffect(() => {
    if (!ro.readOnly || !focused.current) return;
    focused.current = false;
    rootRef.current?.closest<HTMLElement>('li')?.focus();
  }, [ro.readOnly]);

  // While the list is open: focus goes into it, and a press or focus anywhere else closes it without taking focus back.
  useEffect(() => {
    if (!open) return undefined;
    popRef.current?.querySelector<HTMLElement>('[data-tags-item]')?.focus();
    popRef.current?.scrollIntoView?.({ block: 'nearest' });
    const leave = (e: Event): void => {
      if (e.target instanceof Node && !rootRef.current?.contains(e.target)) {
        focused.current = false;
        setOpen(false);
      }
    };
    document.addEventListener('pointerdown', leave, true);
    document.addEventListener('focusin', leave, true);
    return () => {
      document.removeEventListener('pointerdown', leave, true);
      document.removeEventListener('focusin', leave, true);
    };
  }, [open]);

  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>): void => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      close(true);
      return;
    }
    // A checkbox answers Space by itself; Enter ticks it too, as the owner asked, and a button answers both. Holding Enter down
    // ticks it once, not at the speed the keyboard repeats.
    if (e.key === 'Enter' && e.target instanceof HTMLInputElement) {
      e.preventDefault();
      if (!e.repeat) e.target.click();
      return;
    }
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) return;
    const items = [...e.currentTarget.querySelectorAll<HTMLElement>('[data-tags-item]')];
    if (items.length === 0) return;
    e.preventDefault();
    const at = items.findIndex((el) => el === document.activeElement);
    const down = e.key === 'ArrowDown';
    const to = e.key === 'Home' ? 0 : e.key === 'End' ? items.length - 1 : at < 0 ? (down ? 0 : items.length - 1) : (at + (down ? 1 : -1) + items.length) % items.length;
    items[to]?.focus();
  };

  return (
    <div
      className="subtask-tags"
      ref={rootRef}
      onFocus={() => {
        focused.current = true;
      }}
      onBlur={(e) => {
        // A blur with nowhere to go (the window, an element taken away) is not focus leaving: only a move to another element is.
        if (e.relatedTarget instanceof Node && !e.currentTarget.contains(e.relatedTarget)) focused.current = false;
      }}
    >
      <button
        ref={buttonRef}
        type="button"
        className="subtask-tags-btn"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? popId : undefined}
        aria-label={`Tags for ${name}: ${summaryOf(shown, on)}`}
        disabled={ro.readOnly}
        title={ro.why ?? undefined}
        onClick={() => setOpen((v) => !v)}
      >
        <IconTag />
        {shown === null || on.length === 0 ? (
          <span className="subtask-tags-text">{shown === null ? SAME_AS_TASK : NO_TAG_TEXT}</span>
        ) : (
          on.map((t) => (
            <span key={t.id} className="tag-chip" style={{ background: t.color, color: readableText(t.color) }}>
              <span className="tag-chip-name">{t.name}</span>
            </span>
          ))
        )}
        <IconChevron open={open} />
      </button>
      {open && (
        <div className="subtask-tags-pop" role="dialog" aria-label={`Tags for ${name}`} id={popId} ref={popRef} onKeyDown={onKeyDown}>
          <div className="subtask-tags-head">
            <Button small data-tags-item aria-pressed={shown === null} onClick={() => choose(() => null)}>
              {SAME_AS_TASK}
            </Button>
            <Button small data-tags-item onClick={() => choose((from) => allToggled(live, from))}>
              {allOn ? DESELECT_ALL : SELECT_ALL}
            </Button>
          </div>
          <ul className="subtask-tags-list" aria-label="Choose tags">
            {tags.map((t) => {
              const isOn = ticked.has(t.id);
              return (
                <li key={t.id}>
                  <label className={`tag-option${isOn ? ' tag-option-on' : ''}`} style={isOn ? { background: t.color, color: readableText(t.color) } : undefined}>
                    <input type="checkbox" className="tag-option-box" data-tags-item checked={isOn} onChange={() => choose((from) => toggled(live, from, t.id))} />
                    <span className="tag-dot" style={{ background: t.color }} aria-hidden="true" />
                    <span className="tag-chip-name">{t.name}</span>
                    {isOn && (
                      <span className="tag-tick" aria-hidden="true">
                        ✓
                      </span>
                    )}
                  </label>
                </li>
              );
            })}
          </ul>
          <p className="field-hint">{HINT}</p>
        </div>
      )}
      {note && (
        <p className="subtask-note subtask-tags-note" role="alert">
          {note}
        </p>
      )}
    </div>
  );
}
