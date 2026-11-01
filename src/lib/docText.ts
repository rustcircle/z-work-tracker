import type { RichDoc } from './types';

/** True when a rich-text document holds real text. Mirrors `doc_has_text` in the Rust core. */
export function docHasText(doc: RichDoc): boolean {
  if (!doc || typeof doc !== 'object') return false;
  const node = doc as { type?: unknown; text?: unknown; content?: unknown };
  if (node.type === 'text') return typeof node.text === 'string' && node.text.trim() !== '';
  return Array.isArray(node.content) && node.content.some((c) => docHasText(c as RichDoc));
}

const BLOCKS = new Set(['paragraph', 'heading', 'listItem', 'taskItem', 'blockquote', 'codeBlock', 'hardBreak', 'bulletList', 'orderedList', 'taskList']);

function collect(node: unknown, out: string[]): void {
  if (!node || typeof node !== 'object') return;
  const n = node as { type?: unknown; text?: unknown; content?: unknown };
  if (n.type === 'text') {
    if (typeof n.text === 'string') out.push(n.text);
    return;
  }
  const block = typeof n.type === 'string' && BLOCKS.has(n.type);
  // A space before and after a block keeps "one" and "two" in two items from running into "onetwo".
  if (block) out.push(' ');
  if (Array.isArray(n.content)) for (const c of n.content) collect(c, out);
  if (block) out.push(' ');
}

const plain = new WeakMap<object, string>();

/**
 * The plain text of a rich-text document: every paragraph, heading, quote and list item (task-list items
 * included), separated by single spaces. Worked out once per document object, so typing in a filter box
 * does not walk the documents again.
 */
export function docPlainText(doc: RichDoc): string {
  if (!doc || typeof doc !== 'object') return '';
  const hit = plain.get(doc);
  if (hit !== undefined) return hit;
  const parts: string[] = [];
  collect(doc, parts);
  const text = parts.join('').replace(/\s+/g, ' ').trim();
  plain.set(doc, text);
  return text;
}

/** Lower case with accents removed, so "Cafe" finds "Café" and "ÉCOLE" finds "école". */
export function foldText(text: string): string {
  return text.normalize('NFD').replace(/\p{M}+/gu, '').toLowerCase();
}
