import path from 'node:path';

import { expect, test, type Locator, type Page } from '@playwright/test';

import { SHOTS } from './support';

// The demo seed: My zone Lisbon, Client zone New York, 12 March 2026 (US clocks forward, EU not yet).
const THEMES = [
  ['light', 'light'],
  ['solarizedLight', 'solarized-light'],
  ['solarizedDark', 'solarized-dark'],
  ['dark', 'dark'],
] as const;

interface Violations {
  csp: string[];
  errors: string[];
}

/** Collects Content-Security-Policy violations (event and console) and page errors for the whole test. */
async function watch(page: Page): Promise<Violations> {
  const found: Violations = { csp: [], errors: [] };
  await page.addInitScript(() => {
    document.addEventListener('securitypolicyviolation', (e) => {
      const w = window as unknown as { __csp?: string[] };
      (w.__csp ??= []).push(`${e.violatedDirective} ${e.blockedURI}`);
    });
  });
  page.on('console', (m) => {
    if (m.type() === 'error' || m.type() === 'warning') {
      if (/content security policy/i.test(m.text())) found.csp.push(m.text());
      else if (m.type() === 'error') found.errors.push(m.text());
    }
  });
  page.on('pageerror', (e) => found.errors.push(e.message));
  return found;
}

async function expectClean(page: Page, found: Violations): Promise<void> {
  const fromEvents = await page.evaluate(() => (window as unknown as { __csp?: string[] }).__csp ?? []);
  expect([...found.csp, ...fromEvents], 'CSP violations').toEqual([]);
  expect(found.errors, 'console errors').toEqual([]);
}

const label = (page: Page): Locator => page.getByTestId('active-zone-label');

async function openPicker(page: Page): Promise<Locator> {
  await page.getByRole('button', { name: /^Other/ }).click();
  const dialog = page.getByTestId('zone-picker');
  await expect(dialog).toBeVisible();
  // The country outlines load lazily; wait for them and for the highlight grid before touching the map.
  await expect(dialog.locator('[data-testid="zone-map-countries"] path').first()).toBeAttached();
  await expect(dialog.locator('[data-pin="mine"]')).toBeAttached();
  return dialog;
}

/** Page coordinates of a latitude and longitude on the map at its initial (whole world) view. */
async function pointOnMap(map: Locator, lat: number, lon: number): Promise<{ x: number; y: number }> {
  const box = await map.boundingBox();
  if (!box) throw new Error('map has no box');
  return { x: box.x + ((lon + 180) / 360) * box.width, y: box.y + ((84 - lat) / 144) * box.height };
}

test.describe('zone bar and picker', () => {
  test('bar: shows the zone, switches between My, Client and UTC, and toggles Show both', async ({ page }) => {
    const found = await watch(page);
    await page.goto('/?seed=demo');
    await expect(label(page)).toContainText('Lisbon, WET, UTC+0');
    await expect(page.getByRole('button', { name: 'My time' })).toHaveAttribute('aria-pressed', 'true');

    await page.getByRole('button', { name: 'Client time' }).click();
    await expect(label(page)).toContainText('New York, EDT, UTC-4');
    await expect.poll(() => page.evaluate(() => window.__mock.settings.activeZone)).toBe('America/New_York');

    await page.getByRole('button', { name: 'UTC', exact: true }).click();
    await expect(label(page)).toHaveText(/Showing\s*UTC$/);

    await page.getByRole('button', { name: 'My time' }).click();
    await expect(label(page)).toContainText('Lisbon, WET');
    await expect.poll(() => page.evaluate(() => window.__mock.settings.activeZone)).toBeNull();

    const both = page.getByRole('switch', { name: 'Show both' });
    await both.click();
    await expect(both).toHaveAttribute('aria-checked', 'true');
    await expect.poll(() => page.evaluate(() => window.__mock.settings.showBoth)).toBe(true);
    await expectClean(page, found);
  });

  test('picker: search by city and by offset, keyboard only', async ({ page }) => {
    const found = await watch(page);
    await page.goto('/?seed=demo');
    const dialog = await openPicker(page);
    const search = dialog.getByTestId('zone-search');
    await expect(search).toBeFocused();

    await search.fill('kathmandu');
    await expect(dialog.getByRole('option')).toHaveCount(1);
    await expect(dialog.getByRole('option').first()).toContainText('UTC+5:45');

    await search.fill('utc-4');
    await expect(dialog.getByRole('option', { name: /New York/ })).toBeVisible();
    await expect(dialog.getByRole('option', { name: /Chicago/ })).toHaveCount(0);

    await search.fill('america/den');
    await search.press('Enter');
    await expect(dialog).toBeHidden();
    await expect(label(page)).toContainText('Denver, MDT, UTC-6');
    await expect.poll(() => page.evaluate(() => window.__mock.settings.activeZone)).toBe('America/Denver');
    await expect(page.getByRole('button', { name: 'Other: Denver' })).toHaveAttribute('aria-pressed', 'true');
    await expectClean(page, found);
  });

  test('picker: Escape closes without changing the zone and returns focus to the button', async ({ page }) => {
    await page.goto('/?seed=demo');
    await openPicker(page);
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('zone-picker')).toBeHidden();
    await expect(label(page)).toContainText('Lisbon, WET');
    await expect(page.getByRole('button', { name: /^Other/ })).toBeFocused();
  });

  test('map: a real click on Denver changes the displayed zone', async ({ page }) => {
    const found = await watch(page);
    await page.goto('/?seed=demo');
    const dialog = await openPicker(page);
    const map = dialog.getByTestId('zone-map');
    await expect(map).toHaveAttribute('aria-label', /Selected time zone: Lisbon, Europe\/Lisbon, WET UTC\+0/);

    const p = await pointOnMap(map, 39.0, -105.5); // central Colorado
    await page.mouse.move(p.x, p.y);
    await expect(dialog.getByTestId('zone-map-info')).toContainText('Denver, America/Denver, MDT UTC-6');
    await page.mouse.click(p.x, p.y);

    await expect(dialog).toBeHidden();
    await expect(label(page)).toContainText('Denver, MDT, UTC-6');
    await expect.poll(() => page.evaluate(() => window.__mock.settings.activeZone)).toBe('America/Denver');
    await expectClean(page, found);
  });

  test('map: a click on open ocean picks the nearest named zone', async ({ page }) => {
    await page.goto('/?seed=demo');
    const dialog = await openPicker(page);
    const map = dialog.getByTestId('zone-map');
    const p = await pointOnMap(map, 0, -30); // equatorial Atlantic
    await page.mouse.move(p.x, p.y);
    await expect(dialog.getByTestId('zone-map-info')).toContainText('Nearest zone: Noronha, America/Noronha');
    await page.mouse.click(p.x, p.y);
    await expect(label(page)).toContainText('Noronha');
    await expect.poll(() => page.evaluate(() => window.__mock.settings.activeZone)).toBe('America/Noronha');
  });

  test('map: dragging pans without picking, wheel and buttons zoom, a pin picks its city', async ({ page }) => {
    await page.goto('/?seed=demo');
    const dialog = await openPicker(page);
    const map = dialog.getByTestId('zone-map');
    const box = await map.boundingBox();
    if (!box) throw new Error('no map box');
    const cx = box.x + box.width / 2;
    const cy = box.y + box.height / 2;
    const countries = dialog.getByTestId('zone-map-countries').locator('..');
    const transform = () => countries.getAttribute('transform');
    const before = await transform();

    await dialog.getByRole('button', { name: 'Zoom in' }).click();
    const zoomed = await transform();
    expect(zoomed).not.toBe(before);

    await page.mouse.move(cx, cy);
    await page.mouse.wheel(0, -400);
    await expect.poll(transform).not.toBe(zoomed);
    const afterWheel = await transform();

    await page.mouse.move(cx, cy);
    await page.mouse.down();
    await page.mouse.move(cx + 60, cy + 30, { steps: 6 });
    await page.mouse.up();
    await expect(dialog).toBeVisible();
    expect(await transform()).not.toBe(afterWheel);
    await expect(label(page)).toContainText('Lisbon, WET');

    await dialog.getByRole('button', { name: 'Reset map view' }).click();
    expect(await transform()).toBe(before);

    // Keyboard on the focused map: plus zooms, zero resets.
    await map.focus();
    await page.keyboard.press('+');
    expect(await transform()).not.toBe(before);
    await page.keyboard.press('0');
    expect(await transform()).toBe(before);

    // City pins are clickable: Tokyo is pinned.
    const pin = await pointOnMap(map, 35.68, 139.69);
    await page.mouse.click(pin.x, pin.y);
    await expect(label(page)).toContainText('Tokyo, JST, UTC+9');
  });

  test('picker shows the clock-change and time-difference notices', async ({ page }) => {
    await page.goto('/?seed=demo');
    const dialog = await openPicker(page);
    const notices = dialog.getByTestId('zone-notices');
    await expect(notices).toContainText('My zone · Lisbon, WET, UTC+0');
    await expect(notices).toContainText('Lisbon clocks go forward 1h, 29 Mar');
    await expect(notices).toContainText('Client zone · New York, EDT, UTC-4');
    await expect(notices).toContainText('Now: New York is 4h behind Lisbon');
    await expect(notices).toContainText('New York is 5h behind Lisbon from 29 Mar');
    // A zone without daylight saving gets no change notice of its own.
    await dialog.getByTestId('zone-search').fill('kolkata');
    await expect(notices).toContainText('Highlighted · Kolkata, IST, UTC+5:30');
    await expect(notices.locator('li', { hasText: 'Highlighted' })).toContainText('No clock change is scheduled.');
  });

  test('sends no network requests beyond the app bundle', async ({ page, baseURL }) => {
    const external: string[] = [];
    page.on('request', (r) => {
      const url = r.url();
      if (!url.startsWith(`${baseURL}/`) && !url.startsWith('data:') && !url.startsWith('blob:')) external.push(url);
    });
    await page.goto('/?seed=demo');
    await openPicker(page);
    expect(external).toEqual([]);
  });

  for (const [theme, file] of THEMES) {
    test(`screenshot: picker in ${theme}`, async ({ page }) => {
      const found = await watch(page);
      await page.goto(`/?seed=demo&theme=${theme}`);
      // Start from a US zone so the chosen zone is large enough to see, with the client pin elsewhere.
      await page.getByRole('button', { name: 'Client time' }).click();
      await expect(label(page)).toContainText('New York');
      await page.getByRole('button', { name: /^Other/ }).click();
      const dialog = page.getByTestId('zone-picker');
      await expect(dialog.locator('[data-pin="mine"]')).toBeAttached();
      await expect(dialog.getByRole('option', { selected: true })).toBeVisible();
      const map = dialog.getByTestId('zone-map');
      const box = await map.boundingBox();
      if (!box) throw new Error('no map box');
      // Zoom about a point in the North Atlantic so the US and European zones are both readable.
      const focus = await pointOnMap(map, 42, -50);
      await page.mouse.move(focus.x, focus.y);
      await page.mouse.wheel(0, -366);
      await expect.poll(async () => Number(await map.getAttribute('data-zoom'))).toBeGreaterThan(2.4);
      const k = Number(await map.getAttribute('data-zoom'));
      // Where Chicago landed: zooming about (fx, fy) maps a point p at the first view to f*p + (1-f)*focus.
      const at = await pointOnMap(map, 41.9, -87.6);
      const hoverX = focus.x * (1 - k) + k * at.x;
      const hoverY = focus.y * (1 - k) + k * at.y;
      await page.mouse.move(hoverX, hoverY);
      await expect(dialog.getByTestId('zone-map-info')).toContainText('Chicago, America/Chicago, CDT UTC-5');
      await page.waitForTimeout(300);
      await page.screenshot({ path: path.join(SHOTS, `zone-picker-${file}.png`) });
      await expectClean(page, found);
    });
  }
});
