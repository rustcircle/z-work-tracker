// Pure helpers for the template list and editor.
import { subtaskItems } from '../../lib/subtasks';
import type { RichDoc, Template } from '../../lib/types';

export const MAX_TEMPLATE_NAME = 120;
export const MAX_TEMPLATE_TAGS = 32;

/** The name rules the backend applies: required, at most 120 characters (equal names are allowed). */
export function validateTemplateName(name: string): string | null {
  const n = name.trim();
  if (n === '') return 'Enter a template name.';
  if ([...n].length > MAX_TEMPLATE_NAME) return `A template name can have at most ${MAX_TEMPLATE_NAME} characters.`;
  return null;
}

type DocNode = { type?: unknown; text?: unknown; content?: unknown };

// Every field of a DocNode is optional, so any non-null object is one.
const isNode = (v: unknown): v is DocNode => typeof v === 'object' && v !== null;
const isInline = (v: unknown): boolean => isNode(v) && (v.type === 'text' || v.type === 'hardBreak');

/**
 * The first line with text on it, outside any task list. A paragraph, heading, code block or list item holds
 * a line, and a hard break (Shift+Enter) ends it. A line is all its text nodes joined, as a mark such as bold
 * splits the text of one line into several nodes.
 */
function firstText(node: unknown): string {
  if (!isNode(node) || node.type === 'taskList' || !Array.isArray(node.content)) return '';
  const children: unknown[] = node.content;
  if (!children.some(isInline)) {
    // A container of blocks: the first block with a line.
    for (const child of children) {
      const line = firstText(child);
      if (line) return line;
    }
    return '';
  }
  // A block of inline content.
  let line = '';
  for (const child of children) {
    if (!isNode(child)) continue;
    if (child.type === 'hardBreak') {
      if (line.trim() !== '') break;
      line = '';
    } else if (typeof child.text === 'string') line += child.text;
  }
  return line.trim();
}

/** The first line of text outside any task list, and the task-list items, for a one-glance summary. */
export function templatePreview(doc: RichDoc): { firstLine: string; items: string[] } {
  return { firstLine: firstText(doc), items: subtaskItems(doc).map((i) => i.text) };
}

/** Tags of a template that still exist, in the order the template lists them. */
export const liveTagIds = (template: Pick<Template, 'tags'>, tagIds: ReadonlySet<string>): string[] => template.tags.filter((id) => tagIds.has(id));
