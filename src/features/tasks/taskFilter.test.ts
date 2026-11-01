import { describe, expect, it } from 'vitest';

import { docPlainText, foldText } from '../../lib/docText';
import { fullProject, fullTask } from '../../mocks/factories';
import type { RichDoc } from '../../lib/types';
import { NO_TASK_FILTER, isTaskFilterActive, matchingTaskIds, type TaskFilter } from './taskFilter';

const para = (text: string) => ({ type: 'paragraph', content: [{ type: 'text', text }] });
const list = (type: 'bulletList' | 'orderedList' | 'taskList', items: string[]) => ({
  type,
  content: items.map((text) => ({ type: type === 'taskList' ? 'taskItem' : 'listItem', attrs: type === 'taskList' ? { checked: false } : undefined, content: [para(text)] })),
});
const doc = (...content: unknown[]): RichDoc => ({ type: 'doc', content });

describe('plain text of a rich-text document', () => {
  it('reads paragraphs, headings and every kind of list item, with a space between blocks', () => {
    const d = doc({ type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'Plan' }] }, para('Three directions'), list('orderedList', ['Moodboard', 'Sketches']), list('taskList', ['Final artwork']), list('bulletList', ['One', 'Two']));
    expect(docPlainText(d)).toBe('Plan Three directions Moodboard Sketches Final artwork One Two');
  });

  it('is empty for no document, and ignores marks and unknown nodes', () => {
    expect(docPlainText(null)).toBe('');
    expect(docPlainText({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'bold', marks: [{ type: 'bold' }] }, { type: 'image', attrs: { src: 'x' } }] }] })).toBe('bold');
  });

  it('is worked out once per document object', () => {
    const d = doc(para('once'));
    expect(docPlainText(d)).toBe('once');
    // Mutating the object afterwards does not change the remembered answer: it is keyed by identity.
    (d as { content: unknown[] }).content = [];
    expect(docPlainText(d)).toBe('once');
  });

  it('folds case and accents', () => {
    expect(foldText('Café ÉCOLE Ñandú Çedilha')).toBe('cafe ecole nandu cedilha');
    expect(foldText('straße')).toBe('straße');
  });
});

describe('the task filter', () => {
  const projects = new Map([fullProject({ id: 'p1', name: 'Brand refresh' }), fullProject({ id: 'p2', name: 'Café menu' })].map((p) => [p.id, p]));
  const tasks = [
    fullTask({ id: 'a', projectId: 'p1', name: 'Logo concepts', description: doc(para('Client asked for three directions'), list('orderedList', ['Moodboard', 'Final artwork'])), tags: ['t-concept'] }),
    fullTask({ id: 'b', projectId: 'p1', name: 'Homepage layout', description: doc(para('Wireframes'), list('taskList', ['Hero section'])), tags: ['t-revision'] }),
    fullTask({ id: 'c', projectId: 'p2', name: 'Menu board', description: doc(para('Prices for the café')), tags: ['t-concept', 't-revision'] }),
    fullTask({ id: 'd', projectId: 'p2', name: 'Admin', description: null, tags: [] }),
  ];
  const ids = (f: Partial<TaskFilter>): string[] | null => {
    const out = matchingTaskIds(tasks, projects, { ...NO_TASK_FILTER, ...f });
    return out === null ? null : [...out].sort();
  };

  it('is off when nothing is asked, and hides nothing', () => {
    expect(isTaskFilterActive(NO_TASK_FILTER)).toBe(false);
    expect(isTaskFilterActive({ ...NO_TASK_FILTER, text: '   ' })).toBe(false);
    expect(ids({})).toBeNull();
  });

  it('matches the name, the description and list items, ignoring case and accents', () => {
    expect(ids({ text: 'LOGO' })).toEqual(['a']);
    expect(ids({ text: 'moodboard' })).toEqual(['a']);
    expect(ids({ text: 'hero section' })).toEqual(['b']);
    expect(ids({ text: 'CAFE' })).toEqual(['c', 'd']);
    expect(ids({ text: 'café' })).toEqual(['c', 'd']);
    expect(ids({ text: 'zzz' })).toEqual([]);
  });

  it('combines text, project and tags with AND, and tags with any-of', () => {
    expect(ids({ projectId: 'p1' })).toEqual(['a', 'b']);
    expect(ids({ tagIds: ['t-concept'] })).toEqual(['a', 'c']);
    expect(ids({ tagIds: ['t-concept', 't-revision'] })).toEqual(['a', 'b', 'c']);
    expect(ids({ projectId: 'p1', tagIds: ['t-concept'] })).toEqual(['a']);
    expect(ids({ text: 'directions', projectId: 'p1', tagIds: ['t-revision'] })).toEqual([]);
    expect(ids({ text: 'directions', projectId: 'p1', tagIds: ['t-concept'] })).toEqual(['a']);
  });

  it('collapses spaces in what was typed', () => {
    expect(ids({ text: '  final    artwork ' })).toEqual(['a']);
  });
});
