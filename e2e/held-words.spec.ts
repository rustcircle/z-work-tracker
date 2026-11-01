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

// The gate's probes, in a real browser with real mouse and keyboard events.
test.describe('words that meet newer text', () => {
  const DOC = { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'From another device' }] }] };
  async function arrive(page: Page): Promise<void> {
    await page.evaluate(async (doc) => {
      const task = window.__mock.tasks.find((t) => t.id === 't-guide');
      if (task) task.description = doc;
      await window.__mockEmit('state-changed');
    }, DOC);
  }
  const stored = (page: Page) => page.evaluate(() => JSON.stringify(window.__mock.tasks.find((t) => t.id === 't-guide')?.description));
  const editor = (page: Page) => page.getByRole('form', { name: 'Editing Brand guidelines' });

  async function typedThenNewer(page: Page): Promise<Locator> {
    await page.getByRole('button', { name: 'Edit Brand guidelines' }).click();
    const form = editor(page);
    await form.getByRole('textbox', { name: 'Description' }).click();
    await page.keyboard.type(' mine');
    await arrive(page);
    return form;
  }
  const settled = async (page: Page) => {
    for (let i = 0; i < 3; i++) {
      await page.clock.runFor(500);
      await page.waitForTimeout(100);
    }
  };
  const heldOpen = async (page: Page, form: Locator) => {
    expect(await stored(page)).toContain('From another device');
    expect(await stored(page)).not.toContain('mine');
    await expect(form.getByTestId('save-state')).toHaveAttribute('data-kind', 'conflict');
  };

  test('a clean editor shows newer text, and typing goes on from it', async ({ page }) => {
    await open(page, 'seed=demo');
    await page.getByRole('button', { name: 'Edit Brand guidelines' }).click();
    const form = editor(page);
    const box = form.getByRole('textbox', { name: 'Description' });
    await box.click();
    await arrive(page);
    await expect(box).toContainText('From another device');
    await expect(box).toBeFocused();
    await page.keyboard.type(' x');
    await settled(page);
    expect(await stored(page)).toContain('From another device');
    expect(await stored(page)).toContain(' x');
    await expect(form.getByTestId('save-state')).toHaveAttribute('data-kind', 'saved');
  });

  test('a real click on Done whose blur meets them keeps the editor open', async ({ page }) => {
    await open(page, 'seed=demo');
    const form = await typedThenNewer(page);
    await form.getByRole('button', { name: 'Done' }).click();
    await settled(page);
    await heldOpen(page, form);
  });

  test('the same when the reply lands after the mouse is up', async ({ page }) => {
    await open(page, 'seed=demo');
    const form = await typedThenNewer(page);
    await page.evaluate(() => {
      const w = window as unknown as { __TAURI_INTERNALS__: { invoke: (c: string, a: unknown, o: unknown) => Promise<unknown> }; __release?: () => void };
      const real = w.__TAURI_INTERNALS__.invoke;
      let gate = true;
      w.__TAURI_INTERNALS__.invoke = async (c, a, o) => {
        if (gate && (c === 'get_snapshot' || c === 'patch_task')) {
          gate = false;
          await new Promise<void>((r) => {
            w.__release = r;
          });
        }
        return real(c, a, o);
      };
    });
    const done = form.getByRole('button', { name: 'Done' });
    await done.scrollIntoViewIfNeeded();
    const b = await done.boundingBox();
    if (!b) throw new Error('Done has no box');
    await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
    await page.mouse.down();
    await page.mouse.up();
    await page.evaluate(() => (window as unknown as { __release?: () => void }).__release?.());
    await settled(page);
    await heldOpen(page, form);
  });

  test('typing on keeps them held and the newer text stored', async ({ page }) => {
    await open(page, 'seed=demo');
    const form = await typedThenNewer(page);
    await settled(page);
    await page.keyboard.type(' more');
    await settled(page);
    await heldOpen(page, form);
    await expect(form.getByRole('textbox', { name: 'Description' })).toContainText('more');
    await expect(page.getByRole('alert')).toHaveCount(0);
  });

  test('Done after the notice saves over the newer text', async ({ page }) => {
    await open(page, 'seed=demo');
    const form = await typedThenNewer(page);
    await settled(page);
    await expect(form.getByTestId('save-state')).toHaveAttribute('data-kind', 'conflict');
    await page.clock.runFor(1000);
    await form.getByRole('button', { name: 'Done' }).click();
    await settled(page);
    expect(await stored(page)).toContain('mine');
    await expect(editor(page)).toHaveCount(0);
  });

  test('a press of Done in the first second of the notice saves nothing, and one after it does', async ({ page }) => {
    await open(page, 'seed=demo');
    const form = await typedThenNewer(page);
    const done = form.getByRole('button', { name: 'Done' });
    await done.focus();
    // Enter closes the editor, which saves, which meets the newer text. Focus is still on Done.
    await page.keyboard.press('Enter');
    await expect(form.getByTestId('save-state')).toHaveAttribute('data-kind', 'conflict');
    await expect(done).toBeFocused();
    // The clock stands still here, so these all fall inside the notice's first second.
    await page.keyboard.press('Enter');
    await page.keyboard.press('Enter');
    await done.click();
    await page.clock.runFor(900);
    await page.keyboard.press('Enter');
    await page.waitForTimeout(100);
    await heldOpen(page, form);
    await page.clock.runFor(100);
    await page.keyboard.press('Enter');
    await settled(page);
    expect(await stored(page)).toContain('mine');
    await expect(editor(page)).toHaveCount(0);
  });

  test('a press of Done whose own blur brings the notice, then a press after its second, saves and closes', async ({ page }) => {
    await open(page, 'seed=demo');
    await page.getByRole('button', { name: 'Edit Brand guidelines' }).click();
    const form = editor(page);
    await form.getByRole('textbox', { name: 'Description' }).click();
    await page.keyboard.type(' mine');
    // The page isn't told. Only the save finds the newer text, and the mock replies without a hop of the event loop.
    await page.evaluate((doc) => {
      const task = window.__mock.tasks.find((t) => t.id === 't-guide');
      if (task) task.description = doc;
    }, DOC);
    const done = form.getByRole('button', { name: 'Done' });
    await done.click();
    await heldOpen(page, form);
    await page.clock.runFor(1100);
    await done.click();
    await settled(page);
    expect(await stored(page)).toContain('mine');
    await expect(editor(page)).toHaveCount(0);
  });

  test('an Enter held down on Done across the second is one press, and chose nothing', async ({ page }) => {
    await open(page, 'seed=demo');
    const form = await typedThenNewer(page);
    await form.getByRole('button', { name: 'Done' }).focus();
    // The first Enter comes with the notice, inside its first second.
    await page.keyboard.down('Enter');
    await expect(form.getByTestId('save-state')).toHaveAttribute('data-kind', 'conflict');
    await page.clock.runFor(1100);
    // Held on, the key repeats: each repeat is a keydown of a key that has been down all along.
    await page.keyboard.down('Enter');
    await page.keyboard.down('Enter');
    await page.keyboard.up('Enter');
    await page.waitForTimeout(100);
    await heldOpen(page, form);
    await page.keyboard.press('Enter');
    await settled(page);
    expect(await stored(page)).toContain('mine');
    await expect(editor(page)).toHaveCount(0);
  });

  test('a press dragged off Done speaks for no later key', async ({ page }) => {
    await open(page, 'seed=demo');
    await page.getByRole('button', { name: 'Edit Brand guidelines' }).click();
    const form = editor(page);
    const done = form.getByRole('button', { name: 'Done' });
    await done.scrollIntoViewIfNeeded();
    const b = await done.boundingBox();
    if (!b) throw new Error('Done has no box');
    // Nothing is held at this press, and with the mouse let go elsewhere it never becomes a click.
    await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
    await page.mouse.down();
    await page.mouse.move(b.x + b.width / 2, b.y - 150);
    await page.mouse.up();
    await expect(form).toBeVisible();
    await form.getByRole('textbox', { name: 'Description' }).click();
    await page.keyboard.type(' mine');
    await arrive(page);
    await settled(page);
    await heldOpen(page, form);
    await page.clock.runFor(1000);
    await done.focus();
    await page.keyboard.press('Enter');
    await settled(page);
    expect(await stored(page)).toContain('mine');
    await expect(editor(page)).toHaveCount(0);
  });

  test('an edit to a task deleted elsewhere goes in a notice with its words', async ({ page }) => {
    const found = await open(page, 'seed=demo');
    await page.getByRole('button', { name: 'Edit Brand guidelines' }).click();
    await editor(page).getByRole('textbox', { name: 'Description' }).click();
    await page.keyboard.type(' mine');
    await page.evaluate(async () => {
      window.__mock.tasks = window.__mock.tasks.filter((t) => t.id !== 't-guide');
      await window.__mockEmit('state-changed');
    });
    const notice = page.getByTestId('notice');
    await expect(notice).toContainText('no longer exists');
    await expect(notice).toContainText('mine');
    await expect(editor(page)).toHaveCount(0);
    await expect(page.getByRole('alert')).toHaveCount(0);
    await settled(page);
    expect(await page.evaluate(() => Object.keys(window.__mock.drafts))).toEqual([]);
    await expectClean(page, found);
  });

  test('a closed editor whose saves keep failing has a banner until a later success sends the words', async ({ page }) => {
    const found = await open(page, 'seed=demo');
    await page.evaluate(() => {
      const w = window as unknown as { __TAURI_INTERNALS__: { invoke: (c: string, a: unknown, o: unknown) => Promise<unknown> }; __down?: boolean };
      const real = w.__TAURI_INTERNALS__.invoke;
      w.__down = true;
      w.__TAURI_INTERNALS__.invoke = (c, a, o) => (w.__down && c === 'patch_task' ? Promise.reject({ code: 'io', message: 'the data file is locked' }) : real(c, a, o));
    });
    await page.getByRole('button', { name: 'Edit Brand guidelines' }).click();
    await editor(page).getByRole('textbox', { name: 'Description' }).click();
    await page.keyboard.type(' mine');
    // The first failure brings up the error banner, which moves the page: the click waits until it has.
    await page.clock.runFor(1000);
    await expect(page.getByRole('alert')).toContainText('the data file is locked');
    await page.getByRole('button', { name: 'Edit Brand guidelines' }).click();
    await expect(editor(page)).toHaveCount(0);
    await page.clock.runFor(70_000);
    const banner = page.getByTestId('unsent-banner');
    await expect(banner).toContainText('could not be saved yet');
    expect(await stored(page)).not.toContain('mine');
    await page.evaluate(() => {
      (window as unknown as { __down?: boolean }).__down = false;
    });
    await page.getByRole('button', { name: 'Hide earnings' }).click();
    await expect(banner).toHaveCount(0);
    await expect(page.getByRole('alert')).toHaveCount(0);
    expect(await stored(page)).toContain('mine');
    await expectClean(page, found);
  });

  test('Discard on several held fields restores them all, and puts the cursor on the first', async ({ page }) => {
    await page.setViewportSize({ width: 980, height: 660 });
    await open(page, 'seed=demo&theme=dark');
    await page.getByRole('button', { name: 'Edit Brand guidelines' }).click();
    const form = page.getByRole('form', { name: /^Editing / });
    await form.getByRole('textbox', { name: 'Task name' }).fill('Brand guidelines v2');
    await page.evaluate(async () => {
      const task = window.__mock.tasks.find((t) => t.id === 't-guide');
      if (task) task.name = 'Renamed elsewhere';
      await window.__mockEmit('state-changed');
    });
    await page.clock.runFor(1000);
    await form.getByRole('combobox', { name: 'Project' }).selectOption('p-web');
    await page.evaluate(async () => {
      const task = window.__mock.tasks.find((t) => t.id === 't-guide');
      if (task) task.projectId = 'p-pack';
      await window.__mockEmit('state-changed');
    });
    await page.clock.runFor(1000);
    await expect(form.getByTestId('save-state')).toContainText('name and project');
    const foot = form.locator('.editor-foot');
    expect(await foot.evaluate((f) => f.scrollWidth <= f.clientWidth)).toBe(true);
    await form.getByRole('button', { name: 'Discard my words' }).click();
    await expect(form.getByRole('textbox', { name: 'Task name' })).toHaveValue('Renamed elsewhere');
    await expect(form.getByRole('combobox', { name: 'Project' })).toHaveValue('p-pack');
    await expect(form.getByRole('textbox', { name: 'Task name' })).toBeFocused();
    await expect(form.getByTestId('save-state')).toHaveAttribute('data-kind', 'discarded');
  });
});
