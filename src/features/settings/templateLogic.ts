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

function firstText(node: unknown): string {
  if (!node || typeof node !== 'object') return '';
  const n = node as { type?: unknown; text?: unknown; content?: unknown };
  if (n.type === 'taskList') return '';
  if (typeof n.text === 'string' && n.text.trim() !== '') return n.text.trim();
  if (Array.isArray(n.content)) {
    for (const c of n.content) {
      const t = firstText(c);
      if (t) return t;
    }
  }
  return '';
}

/** The first line of text outside any task list, and the task-list items, for a one-glance summary. */
export function templatePreview(doc: RichDoc): { firstLine: string; items: string[] } {
  return { firstLine: firstText(doc), items: subtaskItems(doc).map((i) => i.text) };
}

/** Tags of a template that still exist, in the order the template lists them. */
export const liveTagIds = (template: Pick<Template, 'tags'>, tagIds: ReadonlySet<string>): string[] => template.tags.filter((id) => tagIds.has(id));
