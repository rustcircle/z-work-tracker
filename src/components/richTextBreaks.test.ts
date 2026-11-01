import { Editor } from '@tiptap/react';
import { describe, expect, it } from 'vitest';

import { templatePreview } from '../features/settings/templateLogic';
import { NO_TASK_FILTER, matchingTaskIds } from '../features/tasks/taskFilter';
import { docHasText, docPlainText } from '../lib/docText';
import { subtaskItems } from '../lib/subtasks';
import type { RichDoc } from '../lib/types';
import { fullProject, fullTask } from '../mocks/factories';
import { extensions } from './RichText';

// What Shift+Enter (a line break inside the paragraph) and Enter (a new paragraph) leave in a description,
// and that every place which turns a description into plain text keeps the words on both sides apart.
// The documents come from the production editor's own extensions and keymap, not from hand-written JSON.

/** The editor's JSON after `keys` ran on an empty one. */
function written(keys: (editor: Editor) => void): RichDoc {
  const editor = new Editor({ extensions: extensions(), content: '' });
  try {
    keys(editor);
    return editor.getJSON() as RichDoc;
  } finally {
    editor.destroy();
  }
}

const type = (editor: Editor, words: string): void => void editor.commands.insertContent(words);
const shiftEnter = (editor: Editor): void => void editor.commands.keyboardShortcut('Shift-Enter');
const enter = (editor: Editor): void => void editor.commands.keyboardShortcut('Enter');

const text = (t: string) => ({ type: 'text', text: t });
const hardBreak = { type: 'hardBreak' };

const SAMPLE = written((e) => {
  type(e, 'one');
  shiftEnter(e);
  type(e, 'two');
  enter(e);
  type(e, 'three');
});

const TASKS = written((e) => {
  e.commands.toggleTaskList();
  type(e, 'one');
  shiftEnter(e);
  type(e, 'two');
  enter(e);
  type(e, 'three');
});

describe('what the keys leave in the document', () => {
  it('Shift+Enter is a break inside the paragraph and Enter starts the next one', () => {
    expect(SAMPLE).toEqual({
      type: 'doc',
      content: [
        { type: 'paragraph', content: [text('one'), hardBreak, text('two')] },
        { type: 'paragraph', content: [text('three')] },
      ],
    });
  });

  it('in a task list Shift+Enter stays in the item and Enter starts the next item', () => {
    const list = (TASKS as { content: { type: string; content: { type: string; content: unknown[] }[] }[] }).content[0];
    expect(list?.type).toBe('taskList');
    expect(list?.content.map((item) => item.type)).toEqual(['taskItem', 'taskItem']);
    expect(list?.content[0]?.content).toEqual([{ type: 'paragraph', content: [text('one'), hardBreak, text('two')] }]);
    expect(list?.content[1]?.content).toEqual([{ type: 'paragraph', content: [text('three')] }]);
  });
});

describe('plain text keeps the words on both sides of a break or a paragraph apart', () => {
  it('reads one two three, never onetwo or twothree', () => {
    expect(docPlainText(SAMPLE)).toBe('one two three');
    expect(docPlainText(TASKS)).toBe('one two three');
  });

  it('is what copying out of the editor gives: a line for a break, a blank line between paragraphs', () => {
    const editor = new Editor({ extensions: extensions(), content: SAMPLE });
    try {
      expect(editor.getText()).toBe('one\ntwo\n\nthree');
    } finally {
      editor.destroy();
    }
  });

  it('keeps a word whole when a mark starts or ends inside it', () => {
    const marked = written((e) => {
      type(e, 'He');
      e.commands.toggleBold();
      type(e, 'llo');
      e.commands.toggleBold();
      type(e, ' wor');
      e.commands.toggleItalic();
      type(e, 'ld');
    });
    expect(docPlainText(marked)).toBe('Hello world');
  });

  it('counts as text when there is some, and not when only breaks and empty paragraphs are there', () => {
    expect(docHasText(SAMPLE)).toBe(true);
    expect(
      docHasText(
        written((e) => {
          shiftEnter(e);
          enter(e);
          shiftEnter(e);
        }),
      ),
    ).toBe(false);
  });

  it('is what the task filter searches: a word after a break is found, and so is a phrase across it', () => {
    const projects = new Map([fullProject({ id: 'p', name: 'Project' })].map((p) => [p.id, p]));
    const ids = (needle: string): string[] => {
      const tasks = [fullTask({ id: 'plain', projectId: 'p', name: 'Plain', description: SAMPLE }), fullTask({ id: 'list', projectId: 'p', name: 'Listed', description: TASKS }), fullTask({ id: 'other', projectId: 'p', name: 'Other', description: null })];
      return [...(matchingTaskIds(tasks, projects, { ...NO_TASK_FILTER, text: needle }) ?? [])].sort();
    };
    expect(ids('two')).toEqual(['list', 'plain']);
    expect(ids('one two')).toEqual(['list', 'plain']);
    expect(ids('two three')).toEqual(['list', 'plain']);
    expect(ids('onetwo')).toEqual([]);
    expect(ids('twothree')).toEqual([]);
  });

  it('is the text of a subtask and of the template preview: a break is a space', () => {
    expect(subtaskItems(TASKS).map((i) => i.text)).toEqual(['one two', 'three']);
    expect(templatePreview(TASKS).items).toEqual(['one two', 'three']);
  });

  it('keeps two paragraphs of one list item apart too, as a paste of such a list makes them', () => {
    const pasted = written((e) => {
      e.commands.setContent('<ul data-type="taskList"><li data-type="taskItem" data-checked="false"><p>One</p><p>Two</p></li></ul>');
    });
    expect(subtaskItems(pasted).map((i) => i.text)).toEqual(['One Two']);
    expect(templatePreview(pasted).items).toEqual(['One Two']);
  });
});
