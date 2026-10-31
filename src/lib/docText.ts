import type { RichDoc } from './types';

/** True when a rich-text document holds real text. Mirrors `doc_has_text` in the Rust core. */
export function docHasText(doc: RichDoc): boolean {
  if (!doc || typeof doc !== 'object') return false;
  const node = doc as { type?: unknown; text?: unknown; content?: unknown };
  if (node.type === 'text') return typeof node.text === 'string' && node.text.trim() !== '';
  return Array.isArray(node.content) && node.content.some((c) => docHasText(c as RichDoc));
}
