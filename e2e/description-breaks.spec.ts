import { expect, test, type Locator, type Page } from '@playwright/test';

import type { RichDoc } from '../src/lib/types';
import { card, expectClean, open } from './support';

// Writing a description with the keyboard: Shift+Enter is a line break inside the paragraph, Enter starts
// a new paragraph, and both come back as typed after the editor is closed and opened again. Real key
// presses in a real browser, against the mock backend in src/mocks, which follows the Rust rules; the
// real backend and webview are covered by scripts/native-smoke.mjs.

const text = (t: string) => ({ type: 'text', text: t });
const hardBreak = { type: 'hardBreak' };
const para = (...content: unknown[]) => ({ type: 'paragraph', content });
const doc = (...content: unknown[]) => ({ type: 'doc', content });

/** The first paragraph holds a break, the second is a paragraph of its own. */
const WRITTEN = doc(para(text('first line'), hardBreak, text('second line')), para(text('next paragraph')));

/** The blocks of an editor as text, a line break shown as a newline: 'one\ntwo' is one paragraph holding a break. */
const blocksOf = (surface: Locator): Promise<string[]> =>
  surface.evaluate((root) =>
    [...root.children].map((block) =>
      [...block.childNodes]
        .map((n) => (n instanceof HTMLBRElement ? (n.classList.contains('ProseMirror-trailingBreak') ? '' : '\n') : (n.textContent ?? '')))
        .join(''),
    ),
  );

const storedDescription = (page: Page, taskId: string): Promise<RichDoc | undefined> => page.evaluate((id) => window.__mock.tasks.find((t) => t.id === id)?.description, taskId);

/** For each item of the stored description's task list, the text of its paragraphs, a line break shown as a newline. */
const taskItemsOf = (page: Page, taskId: string): Promise<string[][]> =>
  page.evaluate((id) => {
    const kind = (n: unknown): unknown => (typeof n === 'object' && n !== null && 'type' in n ? n.type : undefined);
    const kids = (n: unknown): unknown[] => (typeof n === 'object' && n !== null && 'content' in n && Array.isArray(n.content) ? n.content : []);
    const words = (n: unknown): string => (kind(n) === 'hardBreak' ? '\n' : typeof n === 'object' && n !== null && 'text' in n ? String(n.text) : kids(n).map(words).join(''));
    const list = kids(window.__mock.tasks.find((t) => t.id === id)?.description).find((n) => kind(n) === 'taskList');
    return kids(list).map((item) => kids(item).filter((b) => kind(b) === 'paragraph').map(words));
  }, taskId);

/** Types the sample: a line, a break, a line, a paragraph. The caret must already be in the editor. */
async function writeSample(page: Page): Promise<void> {
  await page.keyboard.type('first line');
  await page.keyboard.press('Shift+Enter');
  await page.keyboard.type('second line');
  await page.keyboard.press('Enter');
  await page.keyboard.type('next paragraph');
}

test.describe('Shift+Enter and Enter in a description', () => {
  test('in the new-task form a break stays inside its paragraph and Enter starts another, and a saved draft keeps both', async ({ page }) => {
    const found = await open(page, 'seed=demo&launch=cold');
    await page.getByRole('button', { name: 'New task' }).click();
    const form = page.getByRole('form', { name: 'New task' });
    const editor = form.getByRole('textbox', { name: 'Description' });
    await form.getByRole('textbox', { name: 'Task name' }).fill('Break test');
    await form.getByRole('combobox', { name: 'Project' }).selectOption('p-web');
    await editor.click();
    await writeSample(page);
    expect(await blocksOf(editor)).toEqual(['first line\nsecond line', 'next paragraph']);
    await expect(editor.locator('p')).toHaveCount(2);

    await form.getByRole('button', { name: 'Save draft' }).click();
    await expect(card(page, 'Break test')).toBeVisible();
    const id = await page.evaluate(() => window.__mock.tasks.find((t) => t.name === 'Break test')?.id ?? '');
    expect(await storedDescription(page, id)).toEqual(WRITTEN);

    // Shown again, read only.
    await card(page, 'Break test').getByRole('button', { name: 'Description' }).click();
    const view = card(page, 'Break test').getByRole('document', { name: 'Description of Break test' });
    expect(await blocksOf(view)).toEqual(['first line\nsecond line', 'next paragraph']);
    await expectClean(page, found);
  });

  test('in an inline edit it autosaves, and after Done and a reopen the editor and the stored text are as typed', async ({ page }) => {
    const found = await open(page, 'seed=demo');
    await card(page, 'Social templates').getByRole('button', { name: 'Edit Social templates' }).click();
    const form = page.getByRole('form', { name: 'Editing Social templates' });
    const editor = form.getByRole('textbox', { name: 'Description' });
    await editor.click();
    await writeSample(page);
    expect(await blocksOf(editor)).toEqual(['first line\nsecond line', 'next paragraph']);
    await expect.poll(() => storedDescription(page, 't-next')).toEqual(WRITTEN);
    await expect(form.getByTestId('save-state')).toHaveText('Saved');

    await form.getByRole('button', { name: 'Done' }).click();
    await expect(form).toBeHidden();
    await card(page, 'Social templates').getByRole('button', { name: 'Edit Social templates' }).click();
    const again = page.getByRole('form', { name: 'Editing Social templates' }).getByRole('textbox', { name: 'Description' });
    expect(await blocksOf(again)).toEqual(['first line\nsecond line', 'next paragraph']);
    expect(await storedDescription(page, 't-next')).toEqual(WRITTEN);
    await expectClean(page, found);
  });

  test('in a task list a break stays in its item and Enter starts the next, and the Subtasks list and the task filter read the words apart', async ({ page }) => {
    const found = await open(page, 'seed=demo');
    await card(page, 'Brand guidelines').getByRole('button', { name: 'Edit Brand guidelines' }).click();
    const form = page.getByRole('form', { name: 'Editing Brand guidelines' });
    await form.getByRole('textbox', { name: 'Description' }).click();
    await form.getByRole('button', { name: 'Task list' }).click();
    await page.keyboard.type('Call zebra');
    await page.keyboard.press('Shift+Enter');
    await page.keyboard.type('quartz tidy');
    await page.keyboard.press('Enter');
    await page.keyboard.type('Send it');
    await expect.poll(() => taskItemsOf(page, 't-guide')).toEqual([['Call zebra\nquartz tidy'], ['Send it']]);
    await form.getByRole('button', { name: 'Done' }).click();
    await expect(form).toBeHidden();

    // Two items and the row for time with no subtask. A break reads as a space, never as nothing.
    const rows = card(page, 'Brand guidelines').getByRole('region', { name: 'Subtasks' }).getByRole('listitem');
    await expect(rows).toHaveCount(3);
    await expect(rows.nth(0).locator('.subtask-text')).toHaveText('Call zebra quartz tidy');
    await expect(rows.nth(1).locator('.subtask-text')).toHaveText('Send it');

    // The task filter searches the same words: either side of the break, and as a phrase across it.
    const search = page.getByRole('searchbox', { name: 'Search tasks by name or description' });
    for (const [needle, shown] of [
      ['quartz', true],
      ['zebra quartz', true],
      ['tidy send it', true],
      ['zebraquartz', false],
    ] as const) {
      await search.fill(needle);
      await expect(card(page, 'Logo concepts')).toBeHidden();
      if (shown) await expect(card(page, 'Brand guidelines')).toBeVisible();
      else await expect(card(page, 'Brand guidelines')).toBeHidden();
    }
    await expectClean(page, found);
  });

  test('a pasted list item of two paragraphs reads as one line in the Subtasks list', async ({ page }) => {
    const found = await open(page, 'seed=demo');
    await card(page, 'Brand guidelines').getByRole('button', { name: 'Edit Brand guidelines' }).click();
    const form = page.getByRole('form', { name: 'Editing Brand guidelines' });
    const editor = form.getByRole('textbox', { name: 'Description' });
    await editor.click();
    // What copying a task list whose item has two paragraphs from another page puts on the clipboard.
    await editor.evaluate((el) => {
      const data = new DataTransfer();
      data.setData('text/html', '<ul data-type="taskList"><li data-type="taskItem" data-checked="false"><p>Alpha</p><p>Beta</p></li></ul>');
      el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
    });
    await expect.poll(() => taskItemsOf(page, 't-guide')).toEqual([['Alpha', 'Beta']]);
    await form.getByRole('button', { name: 'Done' }).click();
    await expect(form).toBeHidden();
    const rows = card(page, 'Brand guidelines').getByRole('region', { name: 'Subtasks' }).getByRole('listitem');
    await expect(rows.nth(0).locator('.subtask-text')).toHaveText('Alpha Beta');
    await expectClean(page, found);
  });
});
