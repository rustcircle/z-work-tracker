import path from 'node:path';

import { expect, test, type Locator, type Page } from '@playwright/test';

import { SHOTS, expectClean, open } from './support';

// Words held back because newer text arrived from elsewhere: the notice, and the way to give them up.
// Against the mock backend in src/mocks, which follows the Rust rules.
const THEMES = [
  ['light', 'light'],
  ['solarizedLight', 'solarized-light'],
  ['solarizedDark', 'solarized-dark'],
  ['dark', 'dark'],
] as const;

/** Types words into the open editor, then lets newer text arrive from elsewhere before the autosave. */
async function holdWords(page: Page): Promise<Locator> {
  await page.getByRole('button', { name: 'Edit Brand guidelines' }).click();
  const form = page.getByRole('form', { name: 'Editing Brand guidelines' });
  await form.getByRole('textbox', { name: 'Description' }).click();
  await page.keyboard.type(' my held words');
  await page.evaluate(async () => {
    const task = window.__mock.tasks.find((t) => t.id === 't-guide');
    if (task) task.description = { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'From another device' }] }] };
    await window.__mockEmit('state-changed');
  });
  await page.clock.runFor(1000);
  await expect(form.getByTestId('save-state')).toHaveAttribute('data-kind', 'conflict');
  return form;
}

/** WCAG contrast of an element's text against the opaque colour it sits on. */
function contrastOf(el: Locator): Promise<number> {
  return el.evaluate((node) => {
    const ctx = document.createElement('canvas').getContext('2d');
    if (!ctx) throw new Error('no canvas');
    // Any CSS colour syntax (rgb, color-mix results, color()) becomes plain bytes by painting one pixel.
    const rgba = (css: string): [number, number, number, number] => {
      ctx.clearRect(0, 0, 1, 1);
      ctx.fillStyle = '#000';
      ctx.fillStyle = css;
      ctx.fillRect(0, 0, 1, 1);
      const d = ctx.getImageData(0, 0, 1, 1).data;
      return [d[0] ?? 0, d[1] ?? 0, d[2] ?? 0, (d[3] ?? 0) / 255];
    };
    // The colour behind the text: the nearest backgrounds laid over each other down to an opaque one.
    const layers: [number, number, number, number][] = [];
    for (let e: Element | null = node; e; e = e.parentElement) {
      const c = rgba(getComputedStyle(e).backgroundColor);
      if (c[3] > 0) layers.push(c);
      if (c[3] === 1) break;
    }
    let back: [number, number, number] = [255, 255, 255];
    for (const [r, g, b, a] of layers.reverse()) back = [r * a + back[0] * (1 - a), g * a + back[1] * (1 - a), b * a + back[2] * (1 - a)];
    const fore = rgba(getComputedStyle(node).color);
    const text: [number, number, number] = [fore[0] * fore[3] + back[0] * (1 - fore[3]), fore[1] * fore[3] + back[1] * (1 - fore[3]), fore[2] * fore[3] + back[2] * (1 - fore[3])];
    const lum = ([r, g, b]: [number, number, number]) => {
      const f = (v: number) => {
        const s = v / 255;
        return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
      };
      return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
    };
    const [hi, lo] = [Math.max(lum(text), lum(back)), Math.min(lum(text), lum(back))];
    return (hi + 0.05) / (lo + 0.05);
  });
}

test.describe('Discard my words', () => {
  test('gives the newer text back from the keyboard, and the held words are gone for good', async ({ page }) => {
    const found = await open(page, 'seed=demo');
    const form = await holdWords(page);
    const discard = form.getByRole('button', { name: 'Discard my words' });
    await expect(form.getByTestId('save-state')).toContainText('changed elsewhere');
    await discard.focus();
    await expect(discard).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(form.getByRole('textbox', { name: 'Description' })).toContainText('From another device');
    await expect(form.getByRole('textbox', { name: 'Description' })).not.toContainText('my held words');
    await expect(form.getByTestId('save-state')).toHaveAttribute('data-kind', 'discarded');
    await expect(discard).toHaveCount(0);
    await page.clock.runFor(70_000);
    expect(await page.evaluate(() => JSON.stringify(window.__mock.tasks.find((t) => t.id === 't-guide')?.description))).not.toContain('my held words');
    expect(await page.evaluate(() => Object.keys(window.__mock.drafts))).toEqual([]);
    await expectClean(page, found);
  });

  for (const [theme, file] of THEMES) {
    test(`is visible, legible and focusable in ${theme}`, async ({ page }) => {
      await open(page, `seed=demo&theme=${theme}`);
      const form = await holdWords(page);
      const discard = form.getByRole('button', { name: 'Discard my words' });
      await expect(discard).toBeVisible();
      await expect(discard).toBeEnabled();
      expect(await contrastOf(discard)).toBeGreaterThanOrEqual(4.5);
      expect(await contrastOf(form.getByTestId('save-state'))).toBeGreaterThanOrEqual(4.5);
      // The notice has room to be read, and the buttons sit apart from it, inside the editor and not cut off.
      const [formBox, noticeBox] = await Promise.all([form.boundingBox(), form.getByTestId('save-state').boundingBox()]);
      if (!formBox || !noticeBox) throw new Error('the editor or the notice has no box');
      expect(noticeBox.width).toBeGreaterThanOrEqual(240);
      for (const name of ['Discard my words', 'Save as template', 'Done']) {
        const box = await form.getByRole('button', { name }).boundingBox();
        if (!box) throw new Error(`${name} has no box`);
        expect(box.x, `${name} starts inside the editor`).toBeGreaterThanOrEqual(formBox.x);
        expect(box.x + box.width, `${name} ends inside the editor`).toBeLessThanOrEqual(formBox.x + formBox.width + 1);
        const apart = box.y >= noticeBox.y + noticeBox.height - 1 || noticeBox.y >= box.y + box.height - 1 || box.x >= noticeBox.x + noticeBox.width - 1 || noticeBox.x >= box.x + box.width - 1;
        expect(apart, `${name} overlaps the notice`).toBe(true);
      }
      // A keyboard user sees where the cursor is.
      await discard.focus();
      await page.keyboard.press('Shift+Tab');
      await page.keyboard.press('Tab');
      await expect(discard).toBeFocused();
      expect(await discard.evaluate((el) => getComputedStyle(el).outlineStyle)).toBe('solid');
      await page.screenshot({ path: path.join(SHOTS, `held-words-${file}.png`) });
    });
  }
});
