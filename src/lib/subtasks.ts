// Task-list items of a TipTap document, the unit that can carry its own tracked time. Mirrors
// `subtasks.rs`: the backend assigns missing or repeated ids, a copy keeps the text but forgets ids and ticks.
import type { RichDoc } from './types';

type Json = Record<string, unknown>;

const asObj = (v: unknown): Json | null => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Json) : null);
const kids = (n: Json): Json[] => (Array.isArray(n.content) ? (n.content as unknown[]).map(asObj).filter((x): x is Json => x !== null) : []);
const isList = (t: unknown): boolean => t === 'orderedList' || t === 'bulletList' || t === 'taskList';

function inlineText(n: Json, out: string[]): void {
  if (n.type === 'text') {
    if (typeof n.text === 'string') out.push(n.text);
  } else if (n.type === 'hardBreak') out.push(' ');
  else for (const c of kids(n)) inlineText(c, out);
}

/**
 * The item's own text, without any nested list. A line break is a space, and so is the gap between two
 * paragraphs (a paste can put several in one item), so no two words run together.
 */
function itemText(item: Json): string {
  const parts: string[] = [];
  for (const c of kids(item)) {
    if (isList(c.type)) continue;
    const out: string[] = [];
    inlineText(c, out);
    const text = out.join('').trim();
    if (text !== '') parts.push(text);
  }
  return parts.join(' ');
}

export interface DocItem {
  id: string;
  text: string;
  checked: boolean;
}

/** Every task-list item in document order. A missing id reads as an empty string. */
export function subtaskItems(doc: RichDoc | undefined): DocItem[] {
  const out: DocItem[] = [];
  const walk = (n: Json): void => {
    if (n.type === 'taskItem') {
      const attrs = asObj(n.attrs);
      out.push({ id: typeof attrs?.subtaskId === 'string' ? attrs.subtaskId : '', text: itemText(n), checked: attrs?.checked === true });
    }
    for (const c of kids(n)) walk(c);
  };
  const root = asObj(doc);
  if (root) walk(root);
  return out;
}

function mapItems(node: Json, f: (attrs: Json, text: string) => void): void {
  if (node.type === 'taskItem') {
    const text = itemText(node);
    const attrs = asObj(node.attrs) ?? {};
    node.attrs = attrs;
    f(attrs, text);
  }
  if (Array.isArray(node.content)) for (const c of node.content as unknown[]) {
    const o = asObj(c);
    if (o) mapItems(o, f);
  }
}

/** For a copy: keeps the text, unticks everything and forgets ids, so no time carries over. */
export function resetSubtasks(doc: RichDoc): RichDoc {
  if (!doc) return doc;
  const out = structuredClone(doc) as Json;
  mapItems(out, (attrs) => {
    attrs.checked = false;
    delete attrs.subtaskId;
  });
  return out;
}

/**
 * Gives each item a stable id. An editor may send items back without one, so a missing id is recovered
 * from the previous version by text, then by position, and only then generated with `fresh`.
 */
export function assignSubtaskIds(doc: RichDoc, previous: RichDoc | undefined, fresh: () => string): RichDoc {
  if (!doc) return doc;
  const old = subtaskItems(previous);
  const used = subtaskItems(doc).map((i) => i.id).filter((i) => i !== '');
  const out = structuredClone(doc) as Json;
  let position = 0;
  const seen = new Set<string>();
  mapItems(out, (attrs, text) => {
    const here = position;
    position += 1;
    const current = attrs.subtaskId;
    // An id that an earlier item already holds (a pasted or duplicated item) is reassigned.
    if (typeof current === 'string' && current !== '' && !seen.has(current)) {
      seen.add(current);
      return;
    }
    const byText = old.find((o) => o.text === text && o.id !== '' && !used.includes(o.id));
    const placed = old[here];
    const byPlace = placed && placed.id !== '' && !used.includes(placed.id) ? placed : undefined;
    const id = (byText ?? byPlace)?.id ?? fresh();
    used.push(id);
    seen.add(id);
    attrs.subtaskId = id;
  });
  return out;
}
