import { Editor } from '@tiptap/react';
import { TaskList } from '@tiptap/extension-task-list';
import StarterKit from '@tiptap/starter-kit';
import { describe, expect, it } from 'vitest';

import { subtaskItems } from '../lib/subtasks';
import { SubtaskItem } from './RichText';

const doc = (items: { id?: string; text: string; checked?: boolean }[]) => ({
  type: 'doc',
  content: [
    {
      type: 'taskList',
      content: items.map((i) => ({
        type: 'taskItem',
        attrs: { checked: i.checked ?? false, ...(i.id ? { subtaskId: i.id } : {}) },
        content: [{ type: 'paragraph', content: [{ type: 'text', text: i.text }] }],
      })),
    },
  ],
});

function roundTrip(content: ReturnType<typeof doc>) {
  const editor = new Editor({ extensions: [StarterKit, TaskList, SubtaskItem.configure({ nested: true })], content });
  const out = editor.getJSON();
  editor.destroy();
  return out;
}

describe('task-list items keep their subtask id', () => {
  it('through the editor JSON, in order and after the text of an item changes', () => {
    const out = roundTrip(doc([{ id: 'a', text: 'Sketch' }, { id: 'b', text: 'Colour', checked: true }]));
    expect(subtaskItems(out)).toEqual([
      { id: 'a', text: 'Sketch', checked: false },
      { id: 'b', text: 'Colour', checked: true },
    ]);
  });

  it('leaves an item without an id empty, for the backend to assign', () => {
    const out = roundTrip(doc([{ text: 'New item' }]));
    expect(subtaskItems(out)).toEqual([{ id: '', text: 'New item', checked: false }]);
  });

  it('does not put the id on screen as text', () => {
    const editor = new Editor({ extensions: [StarterKit, TaskList, SubtaskItem], content: doc([{ id: 'secret-id', text: 'Sketch' }]) });
    expect(editor.getText().trim()).toBe('Sketch');
    expect(editor.getHTML()).toContain('data-subtask-id="secret-id"');
    editor.destroy();
  });
});
