// Task descriptions. TipTap is the only place a description is ever rendered, editable or not, so no
// raw HTML is injected anywhere. Its CSS ships in styles/tiptap.css (injectCSS is off for the CSP).
import { EditorContent, useEditor, useEditorState, type Editor } from '@tiptap/react';
import { TaskItem } from '@tiptap/extension-task-item';
import { TaskList } from '@tiptap/extension-task-list';
import StarterKit from '@tiptap/starter-kit';
import { useEffect, useId, useRef } from 'react';

import type { RichDoc } from '../lib/types';

function extensions() {
  return [
    StarterKit.configure({ link: false, underline: false, blockquote: false, code: false, codeBlock: false, strike: false, horizontalRule: false }),
    TaskList,
    TaskItem.configure({ nested: true }),
  ];
}

const docToEditorContent = (doc: RichDoc) => (doc ?? '');

function Toolbar({ editor }: { editor: Editor }) {
  const s = useEditorState({
    editor,
    selector: ({ editor: e }) => ({
      bold: e.isActive('bold'),
      italic: e.isActive('italic'),
      h1: e.isActive('heading', { level: 1 }),
      h2: e.isActive('heading', { level: 2 }),
      h3: e.isActive('heading', { level: 3 }),
      bullet: e.isActive('bulletList'),
      ordered: e.isActive('orderedList'),
      task: e.isActive('taskList'),
    }),
  });
  const items: { label: string; text: string; on: boolean; run: () => void; title: string }[] = [
    { label: 'Bold', text: 'B', on: s.bold, run: () => editor.chain().focus().toggleBold().run(), title: 'Bold' },
    { label: 'Italic', text: 'I', on: s.italic, run: () => editor.chain().focus().toggleItalic().run(), title: 'Italic' },
    { label: 'Heading 1', text: 'H1', on: s.h1, run: () => editor.chain().focus().toggleHeading({ level: 1 }).run(), title: 'Heading 1' },
    { label: 'Heading 2', text: 'H2', on: s.h2, run: () => editor.chain().focus().toggleHeading({ level: 2 }).run(), title: 'Heading 2' },
    { label: 'Heading 3', text: 'H3', on: s.h3, run: () => editor.chain().focus().toggleHeading({ level: 3 }).run(), title: 'Heading 3' },
    { label: 'Bullet list', text: '•≡', on: s.bullet, run: () => editor.chain().focus().toggleBulletList().run(), title: 'Bullet list' },
    { label: 'Numbered list', text: '1.≡', on: s.ordered, run: () => editor.chain().focus().toggleOrderedList().run(), title: 'Numbered list' },
    { label: 'Task list', text: '☑≡', on: s.task, run: () => editor.chain().focus().toggleTaskList().run(), title: 'Task list' },
  ];
  return (
    <div className="rt-toolbar" role="toolbar" aria-label="Formatting">
      {items.map((i) => (
        <button key={i.label} type="button" className={`rt-btn ${i.on ? 'on' : ''}`} aria-label={i.label} aria-pressed={i.on} title={i.title} onClick={i.run}>
          <span aria-hidden="true" className={i.label === 'Bold' ? 'rt-b' : i.label === 'Italic' ? 'rt-i' : ''}>
            {i.text}
          </span>
        </button>
      ))}
    </div>
  );
}

/** The editable description field. `label` names the editing surface for assistive technology. */
export function RichEditor({ label, value, onChange }: { label: string; value: RichDoc; onChange: (doc: RichDoc) => void }) {
  const labelId = useId();
  const onChangeRef = useRef(onChange);
  useEffect(() => {
    onChangeRef.current = onChange;
  });
  const editor = useEditor({
    extensions: extensions(),
    content: docToEditorContent(value),
    injectCSS: false,
    editorProps: { attributes: { role: 'textbox', 'aria-multiline': 'true', 'aria-labelledby': labelId, class: 'rt-content' } },
    onUpdate: ({ editor: e }) => onChangeRef.current(e.isEmpty ? null : (e.getJSON() as RichDoc)),
  });
  return (
    <div className="rt">
      <span id={labelId} className="field-label">
        {label}
      </span>
      <div className="rt-frame">
        {editor && <Toolbar editor={editor} />}
        <EditorContent editor={editor} />
      </div>
    </div>
  );
}

/** Read-only rendering of a stored description. */
export function RichView({ doc, label }: { doc: RichDoc; label: string }) {
  const editor = useEditor({
    extensions: extensions(),
    content: docToEditorContent(doc),
    editable: false,
    injectCSS: false,
    editorProps: { attributes: { role: 'document', 'aria-label': label, class: 'rt-content rt-readonly' } },
  });
  const json = JSON.stringify(doc);
  useEffect(() => {
    if (editor && JSON.stringify(editor.getJSON()) !== json && !(doc === null && editor.isEmpty)) {
      editor.commands.setContent(docToEditorContent(doc), { emitUpdate: false });
    }
  }, [editor, json, doc]);
  return <EditorContent editor={editor} />;
}

/** True when the description holds any text, so the card can offer a "Details" toggle. */
export function hasDescription(doc: RichDoc): boolean {
  if (!doc) return false;
  const walk = (n: unknown): boolean => {
    if (!n || typeof n !== 'object') return false;
    const node = n as { text?: unknown; content?: unknown };
    if (typeof node.text === 'string' && node.text.trim() !== '') return true;
    return Array.isArray(node.content) && node.content.some(walk);
  };
  return walk(doc);
}
