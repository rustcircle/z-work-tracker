import { expect, test, type Locator, type Page } from '@playwright/test';

import { card, expectClean, open } from './support';

// Typing straight after a click on the description toolbar, with no wait in between. The toolbar buttons
// must not take focus on a mouse press, and the editor must hold the caret before the command runs;
// otherwise the first keys land on the button (a Space would even press it) and the text is lost.
// Each case also runs with every animation frame delayed by 400 ms, which models a slow WebView2 and is
// the case that fails deterministically without the fix.

const SURFACES = ['the new-task form', 'inline edit'] as const;
type Surface = (typeof SURFACES)[number];

const BUTTONS = [
  { name: 'Bold', inside: 'strong' },
  { name: 'Bullet list', inside: 'ul > li' },
] as const;

const TEXTS = ['Hello world', ' leading space and more'] as const;

async function openSurface(page: Page, surface: Surface, realTimers = false): Promise<{ form: Locator; editor: Locator; name: Locator }> {
  // A cold launch, so the new-task form starts with an empty description instead of a copy of the last task's.
  // `open` installs the test clock, which also holds back animation frames; real timers are the plain browser.
  if (realTimers) {
    await page.goto('/?seed=demo&launch=cold');
    await expect(page.getByRole('tab', { name: 'Timeline' })).toBeVisible();
  } else await open(page, 'seed=demo&launch=cold');
  if (surface === 'the new-task form') {
    await page.getByRole('button', { name: 'New task' }).click();
    const form = page.getByRole('form', { name: 'New task' });
    return { form, editor: form.getByRole('textbox', { name: 'Description' }), name: form.getByRole('textbox', { name: 'Task name' }) };
  }
  await card(page, 'Social templates').getByRole('button', { name: 'Edit Social templates' }).click();
  const form = page.getByRole('form', { name: 'Editing Social templates' });
  return { form, editor: form.getByRole('textbox', { name: 'Description' }), name: form.getByRole('textbox', { name: 'Task name' }) };
}

/** Every frame arrives 400 ms late, like a loaded machine. */
const slowFrames = (page: Page): Promise<void> =>
  page.evaluate(() => {
    window.requestAnimationFrame = (cb: FrameRequestCallback): number => window.setTimeout(() => cb(performance.now()), 400);
  });

test.describe('typing right after a toolbar click keeps every character', () => {
  for (const surface of SURFACES) {
    for (const button of BUTTONS) {
      for (const text of TEXTS) {
        for (const slow of [false, true]) {
          test(`${surface}, ${button.name}, ${JSON.stringify(text)}${slow ? ', frames 400 ms late' : ''}`, async ({ page }) => {
            const { form, editor, name } = await openSurface(page, surface);
            const nameBefore = await name.inputValue();
            if (slow) await slowFrames(page);
            await form.getByRole('button', { name: button.name }).click();
            // No wait at all: the keys follow the click directly.
            await page.keyboard.type(text);
            await expect.poll(() => editor.evaluate((el) => el.textContent)).toBe(text);
            expect(await editor.locator(button.inside).evaluateAll((els) => els.map((e) => e.textContent).join(''))).toBe(text);
            // Nothing went to the name field, and no button was pressed by a Space.
            await expect(name).toHaveValue(nameBefore);
            await expect(form.getByRole('button', { name: button.name })).toHaveAttribute('aria-pressed', 'true');
            await expect(editor).toBeFocused();
          });
        }
      }
    }
  }

  for (const surface of SURFACES) {
    test(`${surface}, real timers and real animation frames, repeated`, async ({ page }) => {
      const { form, editor, name } = await openSurface(page, surface, true);
      for (const [i, button] of [BUTTONS[0], BUTTONS[1], BUTTONS[0], BUTTONS[1]].entries()) {
        const text = TEXTS[i % TEXTS.length] ?? 'x';
        await editor.click();
        await page.keyboard.press('ControlOrMeta+a');
        await page.keyboard.press('Delete');
        await form.getByRole('button', { name: button.name }).click();
        await page.keyboard.type(text);
        await expect.poll(() => editor.evaluate((el) => el.textContent), { message: `${button.name} then ${JSON.stringify(text)}` }).toContain(text);
        await expect(name).not.toHaveValue(/leading|Hello/);
      }
    });
  }

  test('with the caret already in the editor, a click on the toolbar does not take it away', async ({ page }) => {
    const { form, editor } = await openSurface(page, 'the new-task form');
    await slowFrames(page);
    await editor.click();
    await page.keyboard.type('before ');
    await form.getByRole('button', { name: 'Bold' }).click();
    await page.keyboard.type('after');
    await expect.poll(() => editor.evaluate((el) => el.textContent)).toBe('before after');
    expect(await editor.locator('strong').evaluateAll((els) => els.map((e) => e.textContent).join(''))).toBe('after');
    await expect(editor).toBeFocused();
  });

  test('a mouse press on the toolbar does not blur the editor of an inline edit', async ({ page }) => {
    const { form, editor } = await openSurface(page, 'inline edit');
    await editor.click();
    await page.keyboard.type('draft');
    await form.getByRole('button', { name: 'Italic' }).hover();
    await page.mouse.down();
    await expect(editor).toBeFocused();
    await page.mouse.up();
    await expect(editor).toBeFocused();
  });

  test('the toolbar still works from the keyboard alone, with Enter and with Space', async ({ page }) => {
    const found = await open(page, 'seed=demo&launch=cold');
    await page.getByRole('button', { name: 'New task' }).click();
    const form = page.getByRole('form', { name: 'New task' });
    const editor = form.getByRole('textbox', { name: 'Description' });
    for (const [key, button, inside, text] of [
      ['Enter', 'Bold', 'strong', 'one'],
      ['Space', 'Italic', 'em', 'two'],
    ] as const) {
      await editor.click();
      await form.getByRole('button', { name: button }).focus();
      await expect(form.getByRole('button', { name: button })).toBeFocused();
      await page.keyboard.press(key);
      await expect(form.getByRole('button', { name: button })).toHaveAttribute('aria-pressed', 'true');
      await expect(editor).toBeFocused();
      await page.keyboard.type(text);
      expect(await editor.locator(inside).evaluateAll((els) => els.map((e) => e.textContent).join(''))).toBe(text);
    }
    await expectClean(page, found);
  });
});
