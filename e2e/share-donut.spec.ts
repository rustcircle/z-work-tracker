import { expect, test, type Locator, type Page } from '@playwright/test';
import path from 'node:path';

import { SHOTS, expectClean, watch, type Violations } from './support';

// The "Share of time" donut and its legend in Analysis. Demo seed: 12 March 2026 15:20 UTC, Thursday; My zone Lisbon.
// `?seed=many-tasks` is the demo plus six tasks with time, and tags and subtasks to divide it by (src/mocks/manyTasksSeed.ts):
//   week 9-15 Mar: 10 tasks (8 shown + "Other (2 tasks)"); week 2-8 Mar: exactly 9 tasks; March: 10; Q1: 11.
// Figures for the demo week were derived by hand from the demo segments (see src/features/analysis/demo.test.ts):
//   Billable (15 min, up, once per task per day), centre 24h 15m;  Exact, centre 23h 30m.
const DEMO_NOW = new Date('2026-03-12T15:20:00Z');
const THEMES = ['light', 'solarizedLight', 'solarizedDark', 'dark'] as const;

const FIG = /^\d+h \d{2}m \((\d{1,3}%|<1%)\)$/;

interface Row {
  /** The name as written: a project, "Other (N tasks)", or a task's, subtask's or tag combination's own name. */
  name: string;
  /** The first name after it, muted: a task's project, a subtask's task. */
  project: string | null;
  /** Every name after it, in order: a subtask's task and then its project. */
  context: string[];
  /** The number of colours in a striped swatch, or null for a plain one. */
  stripes: string | null;
  hm: string;
  pct: string;
  fig: string;
  swatch: string;
  open: boolean;
  hasButton: boolean;
  buttonLabel: string | null;
  title: string | null;
  nameLeft: number;
  nameRight: number;
  hmLeft: number;
  hmRight: number;
  pctRight: number;
  figLeft: number;
}

async function openAnalysis(page: Page, query = 'seed=demo'): Promise<Violations> {
  const found = await watch(page);
  await page.clock.install({ time: DEMO_NOW });
  await page.clock.pauseAt(new Date(DEMO_NOW.getTime() + 1000));
  await page.goto(`/?${query}`);
  await page.getByRole('tab', { name: 'Analysis' }).click();
  await expect(page.getByRole('heading', { name: 'Analysis', level: 1 })).toBeVisible();
  await expect(page.getByRole('list', { name: 'Key figures' })).toBeVisible();
  return found;
}

const controls = (page: Page): Locator => page.getByRole('group', { name: 'Analysis controls' });
const share = (page: Page): Locator => page.locator('article.a-card', { has: page.getByRole('heading', { name: 'Share of time', exact: true }) });
const legend = (page: Page): Locator => share(page).locator('ul.a-share-legend');
const rowsOf = (page: Page): Locator => legend(page).locator('> li');
const centre = (page: Page): Locator => share(page).locator('.a-donut-total');
const donut = (page: Page): Locator => share(page).getByRole('img', { name: /^Share of time per (project|task|subtask|tag)$/ });

type Range = 'Day' | 'Week' | 'Month' | 'Quarter' | 'Year';
const RANGE_LABEL: Record<Range, string> = { Day: 'Thu 12 Mar 2026', Week: '9 Mar – 15 Mar 2026', Month: 'March 2026', Quarter: 'Q1 2026', Year: '2026' };

async function setRange(page: Page, name: Range): Promise<void> {
  await controls(page).getByRole('radio', { name, exact: true }).click();
  await expect(page.getByText(RANGE_LABEL[name], { exact: true }).first()).toBeVisible();
}
async function setBasis(page: Page, name: 'Billable' | 'Exact'): Promise<void> {
  const radio = controls(page).getByRole('radio', { name, exact: true });
  await radio.click();
  await expect(radio).toBeChecked();
}
type View = 'Projects' | 'Tasks' | 'Subtasks' | 'Tags';
async function setView(page: Page, name: View): Promise<void> {
  const radio = share(page).getByRole('radiogroup', { name: 'Share of time by' }).getByRole('radio', { name, exact: true });
  await radio.click();
  await expect(radio).toBeChecked();
  await expect(legend(page)).toHaveAttribute('aria-label', `Share of time legend, ${name.toLowerCase()}`);
}

/** Everything a test needs to know about the legend, read in one go. */
async function readRows(page: Page): Promise<Row[]> {
  return legend(page).evaluate((ul) => {
    const num = (el: Element | null): DOMRect => (el ?? ul).getBoundingClientRect();
    return [...ul.querySelectorAll(':scope > li')].map((li) => {
      const text = (sel: string): string | null => li.querySelector(sel)?.textContent ?? null;
      const button = li.querySelector('button');
      const task = text('.a-share-task');
      const name = li.querySelector('.a-share-name');
      return {
        name: task ?? name?.textContent ?? '',
        project: text('.a-share-project'),
        context: [...li.querySelectorAll('.a-share-project')].map((e) => e.textContent ?? ''),
        stripes: li.querySelector('.a-share-swatch')?.getAttribute('data-stripes') ?? null,
        hm: text('.a-share-hm') ?? '',
        pct: text('.a-share-pct') ?? '',
        fig: text('.a-share-fig') ?? '',
        swatch: getComputedStyle(li.querySelector('.a-share-swatch') as Element).backgroundColor,
        open: li.classList.contains('is-open'),
        hasButton: button !== null,
        buttonLabel: button?.getAttribute('aria-label') ?? button?.textContent ?? null,
        title: name?.getAttribute('title') ?? null,
        nameLeft: num(name).left,
        nameRight: num(name).right,
        hmLeft: num(li.querySelector('.a-share-hm')).left,
        hmRight: num(li.querySelector('.a-share-hm')).right,
        pctRight: num(li.querySelector('.a-share-pct')).right,
        figLeft: num(li.querySelector('.a-share-fig')).left,
      };
    });
  });
}

/** Clicks the middle of slice `index` of the ring (a slice's own box centre can lie in the hole, so work out a point on the ring). */
async function clickSlice(page: Page, index: number): Promise<void> {
  const rows = await readRows(page);
  const total = sum(rows.map((r) => minutesOf(r.hm)));
  const before = sum(rows.slice(0, index).map((r) => minutesOf(r.hm)));
  const mid = (before + minutesOf((rows[index] as Row).hm) / 2) / total;
  const box = await donut(page).boundingBox();
  if (!box) throw new Error('the donut has no box');
  const outer = Math.min(120, Math.max(56, box.width / 2 - 6));
  const radius = (outer + outer * 0.64) / 2;
  const angle = -Math.PI / 2 + mid * 2 * Math.PI;
  await page.mouse.click(box.x + box.width / 2 + radius * Math.cos(angle), box.y + box.height / 2 + radius * Math.sin(angle));
}

const minutesOf = (hm: string): number => {
  const m = /^(?:(\d+)h )?(\d+)m$/.exec(hm);
  if (!m) throw new Error(`not a duration: "${hm}"`);
  return Number(m[1] ?? 0) * 60 + Number(m[2]);
};
/** "(<1%)" counts as 0, as a row that has time but rounds to nothing. */
const percentOf = (pct: string): number => (pct === '(<1%)' ? 0 : Number(/^\((\d{1,3})%\)$/.exec(pct)?.[1] ?? Number.NaN));
const sum = (xs: readonly number[]): number => xs.reduce((a, b) => a + b, 0);
const figures = (rows: readonly Row[]): string[] => rows.map((r) => `${r.name} ${r.fig}`);

/** Hue in degrees of an `rgb(r, g, b)` colour. */
function hueOf(rgb: string): number {
  const m = /rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(rgb);
  if (!m) throw new Error(`not an rgb colour: "${rgb}"`);
  const [r, g, b] = [Number(m[1]) / 255, Number(m[2]) / 255, Number(m[3]) / 255] as const;
  const max = Math.max(r, g, b);
  const d = max - Math.min(r, g, b);
  if (d === 0) return 0;
  const h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return (h * 60 + 360) % 360;
}
const hueGap = (a: number, b: number): number => {
  const d = Math.abs(a - b) % 360;
  return d > 180 ? 360 - d : d;
};

/** The filters of the Analysis bar, as a person uses them. */
async function chooseProject(page: Page, name: string): Promise<void> {
  const menu = page.locator('details.a-menu').first();
  if (!(await menu.evaluate((d) => (d as HTMLDetailsElement).open))) await menu.locator('summary').click();
  await menu.getByRole('checkbox', { name, exact: true }).check();
}
async function chooseTask(page: Page, name: string): Promise<void> {
  await controls(page).getByRole('combobox', { name: 'Task', exact: true }).selectOption({ label: name });
}
const tagFilter = (page: Page): Locator => controls(page).getByRole('group', { name: 'Tag filter' });
async function chooseTag(page: Page, name: string): Promise<void> {
  await tagFilter(page).getByRole('checkbox', { name, exact: true }).check();
}
/** The level that is on. The card draws it in the render of the click that asked for it, but under load a read on the next line can still see the old one, so this waits. */
async function expectView(page: Page, name: View): Promise<void> {
  await expect(share(page).getByRole('radio', { name, exact: true })).toBeChecked();
}
/** The rows of the legend as "name figure", waiting for them to be these. */
async function expectFigures(page: Page, expected: readonly string[]): Promise<void> {
  await expect.poll(async () => figures(await readRows(page))).toEqual(expected);
}

const DEMO_BILLABLE_PROJECTS = ['Brand refresh 15h 00m (62%)', 'Website 6h 15m (26%)', 'Packaging 2h 30m (10%)', 'Admin 0h 30m (2%)'];
const DEMO_BILLABLE_TASKS = ['Logo concepts 8h 45m (36%)', 'Brand guidelines 6h 15m (26%)', 'Homepage layout 6h 15m (26%)', 'Box dieline 2h 30m (10%)', 'Email and invoices 0h 30m (2%)'];
// Exact: 1410 min in all. Projects 875, 365, 150, 20 min; tasks 510, 365, 365, 150, 20 min; largest remainder puts the spare points on the largest fractions.
const DEMO_EXACT_PROJECTS = ['Brand refresh 14h 35m (62%)', 'Website 6h 05m (26%)', 'Packaging 2h 30m (11%)', 'Admin 0h 20m (1%)'];
const DEMO_EXACT_TASKS = ['Logo concepts 8h 30m (36%)', 'Brand guidelines 6h 05m (26%)', 'Homepage layout 6h 05m (26%)', 'Box dieline 2h 30m (11%)', 'Email and invoices 0h 20m (1%)'];

test.describe('legend format and layout', () => {
  test('every row reads "name  16h 50m (47%)" as real text with the figures right-aligned in columns', async ({ page }) => {
    const found = await openAnalysis(page);
    for (const view of ['Projects', 'Tasks'] as const) {
      await setView(page, view);
      const rows = await readRows(page);
      expect(rows.length, `${view}: rows`).toBeGreaterThan(0);
      for (const r of rows) {
        expect(r.fig, `${view}: figure of ${r.name}`).toMatch(FIG);
        expect(r.fig).toBe(`${r.hm} ${r.pct}`);
      }
      const hmRight = rows.map((r) => r.hmRight);
      const pctRight = rows.map((r) => r.pctRight);
      expect(Math.max(...hmRight) - Math.min(...hmRight), `${view}: right edges of the hours column`).toBeLessThanOrEqual(1);
      expect(Math.max(...pctRight) - Math.min(...pctRight), `${view}: right edges of the percentage column`).toBeLessThanOrEqual(1);
      for (const r of rows) {
        expect(r.nameLeft, `${view}: ${r.name} starts before its figures`).toBeLessThan(r.hmLeft);
        expect(r.nameRight, `${view}: ${r.name} ends where the figures begin`).toBeLessThanOrEqual(r.figLeft + 1);
      }
      // Text, not drawing: the row's own text holds the name and the figure, in that order.
      const li = rowsOf(page);
      for (let i = 0; i < rows.length; i += 1) {
        const r = rows[i] as Row;
        const text = ((await li.nth(i).textContent()) ?? '').replace(/\s+/g, ' ').trim();
        expect(text.startsWith(r.name), `${view}: row ${i} text "${text}"`).toBe(true);
        expect(text.endsWith(r.fig), `${view}: row ${i} text "${text}"`).toBe(true);
      }
    }
    await expectClean(page, found);
  });

  test('the legend sits on the page as a list named for its view', async ({ page }) => {
    const found = await openAnalysis(page);
    await expect(share(page).getByRole('list', { name: 'Share of time legend, projects' })).toBeVisible();
    await expect(donut(page)).toHaveAttribute('aria-label', /^Share of time per project/);
    await expect(share(page).getByRole('radio', { name: 'Projects', exact: true })).toBeChecked();
    await expect(share(page).getByRole('radio', { name: 'Tasks', exact: true })).not.toBeChecked();
    await expectClean(page, found);
  });
});

test.describe('the figures add up', () => {
  const RANGES: Range[] = ['Week', 'Month', 'Year', 'Day'];
  for (const seed of ['demo', 'many-tasks']) {
    test(`percentages add up to 100 and minutes to the centre total, both views, both bases, four ranges (${seed})`, async ({ page }) => {
      const found = await openAnalysis(page, `seed=${seed}`);
      for (const range of RANGES) {
        await setRange(page, range);
        for (const basis of ['Billable', 'Exact'] as const) {
          await setBasis(page, basis);
          for (const view of ['Projects', 'Tasks'] as const) {
            await setView(page, view);
            const where = `${seed} ${range} ${basis} ${view}`;
            const rows = await readRows(page);
            expect(rows.length, `${where}: rows`).toBeGreaterThan(0);
            expect(sum(rows.map((r) => percentOf(r.pct))), `${where}: percentages ${rows.map((r) => r.pct).join(' ')}`).toBe(100);
            // "<1%" is allowed only for a row that has time.
            for (const r of rows) if (r.pct === '(<1%)') expect(minutesOf(r.hm), `${where}: ${r.name} has time`).toBeGreaterThan(0);
            const total = minutesOf(((await centre(page).textContent()) ?? '').trim());
            expect(sum(rows.map((r) => minutesOf(r.hm))), `${where}: minutes against centre`).toBe(total);
            for (const r of rows) expect(r.fig, where).toMatch(FIG);
          }
        }
      }
      await expectClean(page, found);
    });
  }

  test('a row with only minutes of time is written "<1%" under Exact and the others still add up to 100', async ({ page }) => {
    const found = await openAnalysis(page, 'seed=many-tasks');
    await controls(page).getByRole('button', { name: 'Previous period' }).click();
    await expect(page.getByText('2 Mar – 8 Mar 2026', { exact: true })).toBeVisible();
    await setView(page, 'Tasks');
    for (const basis of ['Exact', 'Billable'] as const) {
      await setBasis(page, basis);
      const rows = await readRows(page);
      const tiny = rows.find((r) => r.name === 'Label artwork');
      expect(tiny, `${basis}: Label artwork row`).toBeDefined();
      // Exact: 4 minutes of about 34 hours is under 1%. Billable rounds it up to 15 minutes, which the largest remainder lifts to 1%.
      expect(tiny?.fig, basis).toMatch(basis === 'Exact' ? /^0h 04m \(<1%\)$/ : /^0h 15m \(1%\)$/);
      expect(sum(rows.map((r) => percentOf(r.pct))), basis).toBe(100);
    }
    await expectClean(page, found);
  });
});

test.describe('Projects / Tasks switch and the basis', () => {
  test('the switch changes the legend, the donut label and the rows, and back again; the basis changes the figures', async ({ page }) => {
    const found = await openAnalysis(page);
    await expect(centre(page)).toHaveText('24h 15m');
    expect(figures(await readRows(page))).toEqual(DEMO_BILLABLE_PROJECTS);

    await share(page).getByRole('radio', { name: 'Tasks', exact: true }).click();
    await expect(share(page).getByRole('list', { name: 'Share of time legend, tasks' })).toBeVisible();
    await expect(donut(page)).toHaveAttribute('aria-label', /^Share of time per task/);
    expect((await readRows(page)).map((r) => `${r.name} ${r.fig}`)).toEqual(DEMO_BILLABLE_TASKS);
    await expect(centre(page)).toHaveText('24h 15m');

    await share(page).getByRole('radio', { name: 'Projects', exact: true }).click();
    await expect(share(page).getByRole('list', { name: 'Share of time legend, projects' })).toBeVisible();
    await expect(donut(page)).toHaveAttribute('aria-label', /^Share of time per project/);
    expect(figures(await readRows(page))).toEqual(DEMO_BILLABLE_PROJECTS);

    await setBasis(page, 'Exact');
    await expect(centre(page)).toHaveText('23h 30m');
    expect(figures(await readRows(page))).toEqual(DEMO_EXACT_PROJECTS);
    await setView(page, 'Tasks');
    expect((await readRows(page)).map((r) => `${r.name} ${r.fig}`)).toEqual(DEMO_EXACT_TASKS);

    await setBasis(page, 'Billable');
    await expect(centre(page)).toHaveText('24h 15m');
    expect((await readRows(page)).map((r) => `${r.name} ${r.fig}`)).toEqual(DEMO_BILLABLE_TASKS);
    await expectClean(page, found);
  });

  test('the arrow keys move between Projects and Tasks', async ({ page }) => {
    const found = await openAnalysis(page);
    const group = share(page).getByRole('radiogroup', { name: 'Share of time by' });
    const projects = group.getByRole('radio', { name: 'Projects', exact: true });
    const tasks = group.getByRole('radio', { name: 'Tasks', exact: true });
    await projects.focus();
    await page.keyboard.press('ArrowRight');
    await expect(tasks).toBeChecked();
    await expect(tasks).toBeFocused();
    await expect(legend(page)).toHaveAttribute('aria-label', 'Share of time legend, tasks');
    await expect(donut(page)).toHaveAttribute('aria-label', /^Share of time per task/);
    expect((await readRows(page)).map((r) => r.name)).toEqual(['Logo concepts', 'Brand guidelines', 'Homepage layout', 'Box dieline', 'Email and invoices']);
    await page.keyboard.press('ArrowLeft');
    await expect(projects).toBeChecked();
    await expect(legend(page)).toHaveAttribute('aria-label', 'Share of time legend, projects');
    expect((await readRows(page)).map((r) => r.name)).toEqual(['Brand refresh', 'Website', 'Packaging', 'Admin']);
    await expectClean(page, found);
  });

  test('a project filter and the period carry through to the donut and the legend', async ({ page }) => {
    const found = await openAnalysis(page);
    await page.getByText('Projects: all').click();
    await page.getByRole('checkbox', { name: 'Website' }).check();
    await expect(centre(page)).toHaveText('6h 15m');
    // One project chosen: the card moves to its tasks by itself.
    await expect(share(page).getByRole('radio', { name: 'Tasks', exact: true })).toBeChecked();
    expect(figures(await readRows(page))).toEqual(['Homepage layout 6h 15m (100%)']);
    await setView(page, 'Projects');
    expect(figures(await readRows(page))).toEqual(['Website 6h 15m (100%)']);
    await page.getByRole('button', { name: 'Clear filters' }).click();
    await expect(centre(page)).toHaveText('24h 15m');
    await setRange(page, 'Day');
    await expect(centre(page)).toHaveText('3h 30m');
    await expectClean(page, found);
  });
});

test.describe('more tasks than the donut shows', () => {
  test('past 9 tasks the 8 with the most time show and the rest are one "Other (N tasks)" row', async ({ page }) => {
    const found = await openAnalysis(page, 'seed=many-tasks');
    await setView(page, 'Tasks');
    await expect(rowsOf(page)).toHaveCount(9);
    const rows = await readRows(page);
    const other = rows.at(-1) as Row;
    expect(other.name).toBe('Other (2 tasks)');
    expect(other.hasButton, 'Other has no button').toBe(false);
    expect(other.open, 'Other cannot be opened').toBe(false);
    expect(rows.slice(0, -1).every((r) => r.hasButton && r.open)).toBe(true);
    expect(rows.filter((r) => r.name.startsWith('Other')).length).toBe(1);
    // N is the number of tasks with time (View data lists them all) minus the 8 shown.
    await share(page).locator('summary', { hasText: 'View data' }).click();
    const table = share(page).getByRole('table');
    await expect(table.locator('tbody tr')).toHaveCount(10);
    const names = await table.locator('tbody tr th').allTextContents();
    expect(other.name).toBe(`Other (${names.length - 8} tasks)`);
    const shown = rows.slice(0, -1).map((r) => r.name);
    expect(shown).not.toContain('Label artwork');
    expect(shown).not.toContain('Bug triage');
    expect(names).toContain('Label artwork');
    expect(names).toContain('Bug triage');
    // The grouped row is the two smallest tasks, and the card says so.
    await expect(share(page).getByText('Other adds up the 2 tasks with the least time. View data lists every task.')).toBeVisible();
    const otherMinutes = minutesOf(other.hm);
    const total = minutesOf(((await centre(page).textContent()) ?? '').trim());
    expect(sum(rows.map((r) => minutesOf(r.hm)))).toBe(total);
    expect(otherMinutes).toBeGreaterThan(0);
    await expectClean(page, found);
  });

  test('the grouping follows the period: 9 tasks show all, 11 give "Other (3 tasks)"', async ({ page }) => {
    const found = await openAnalysis(page, 'seed=many-tasks');
    await setView(page, 'Tasks');
    // Last week: exactly 9 tasks with time, so none is grouped.
    await controls(page).getByRole('button', { name: 'Previous period' }).click();
    await expect(page.getByText('2 Mar – 8 Mar 2026', { exact: true })).toBeVisible();
    await expect(rowsOf(page)).toHaveCount(9);
    expect((await readRows(page)).some((r) => r.name.startsWith('Other'))).toBe(false);
    await expect(share(page).getByText(/Other adds up/)).toHaveCount(0);
    await controls(page).getByRole('button', { name: 'Next period' }).click();
    await expect(rowsOf(page)).toHaveCount(9);
    // March: 10 tasks; Q1: 11 tasks.
    await setRange(page, 'Month');
    await expect(rowsOf(page).last()).toHaveText(/^Other \(2 tasks\)/);
    await setRange(page, 'Quarter');
    await expect(rowsOf(page)).toHaveCount(9);
    expect((await readRows(page)).at(-1)?.name).toBe('Other (3 tasks)');
    // One day: fewer tasks than the limit.
    await setRange(page, 'Day');
    const day = await readRows(page);
    expect(day.length).toBeLessThanOrEqual(9);
    expect(day.some((r) => r.name.startsWith('Other'))).toBe(false);

    await expectClean(page, found);
  });

  test('with 5 tasks (the demo) there is no Other row and no note about it', async ({ page }) => {
    const found = await openAnalysis(page, 'seed=demo');
    await setView(page, 'Tasks');
    await expect(rowsOf(page)).toHaveCount(5);
    expect((await readRows(page)).some((r) => r.name.startsWith('Other'))).toBe(false);
    await expect(share(page).getByText(/Other adds up/)).toHaveCount(0);
    await expectClean(page, found);
  });

  test('the Projects view never groups, whatever the number of tasks', async ({ page }) => {
    const found = await openAnalysis(page, 'seed=many-tasks');
    const rows = await readRows(page);
    expect(rows.map((r) => r.name)).toEqual(['Brand refresh', 'Website', 'Packaging', 'Admin']);
    await expectClean(page, found);
  });
});

test.describe('colours', () => {
  test('a task is a shade of its project colour: the hue stays within 15 degrees', async ({ page }) => {
    const found = await openAnalysis(page, 'seed=many-tasks');
    const projects = await readRows(page);
    const projectSwatch = new Map(projects.map((r) => [r.name, r.swatch]));
    expect(projectSwatch.size).toBe(4);
    await setView(page, 'Tasks');
    const tasks = (await readRows(page)).filter((r) => r.project !== null);
    expect(tasks.length).toBe(8);
    const perProject = new Map<string, string[]>();
    for (const t of tasks) {
      const base = projectSwatch.get(t.project as string);
      expect(base, `project of ${t.name}`).toBeDefined();
      expect(hueGap(hueOf(t.swatch), hueOf(base as string)), `${t.name} (${t.swatch}) against ${t.project} (${base})`).toBeLessThanOrEqual(15);
      perProject.set(t.project as string, [...(perProject.get(t.project as string) ?? []), t.swatch]);
    }
    // Several tasks of one project are told apart by shade, and a project's only task has the project colour itself.
    for (const [project, swatches] of perProject) {
      expect(new Set(swatches).size, `${project}: distinct shades`).toBe(swatches.length);
      if (swatches.length === 1) expect(swatches[0], `${project}: its only task`).toBe(projectSwatch.get(project));
    }
    expect(perProject.get('Brand refresh')?.length, 'a project with several tasks shown').toBeGreaterThanOrEqual(3);
    // The grouped rest has a colour of its own, not one of the projects'.
    const other = (await readRows(page)).at(-1) as Row;
    expect(other.name).toBe('Other (2 tasks)');
    expect([...projectSwatch.values()]).not.toContain(other.swatch);
    expect(tasks.map((t) => t.swatch)).not.toContain(other.swatch);
    await expectClean(page, found);
  });

  test('the legend swatch is the slice colour', async ({ page }) => {
    const found = await openAnalysis(page);
    for (const view of ['Projects', 'Tasks'] as const) {
      await setView(page, view);
      const rows = await readRows(page);
      const fills = await donut(page).locator('path.a-slice').evaluateAll((els) => els.map((e) => getComputedStyle(e).fill));
      expect(fills).toEqual(rows.map((r) => r.swatch));
    }
    await expectClean(page, found);
  });
});

test.describe('click-through', () => {
  const drill = (page: Page, title: string): Locator => page.getByRole('dialog', { name: `Drill-down: ${title}` });

  test('a project row and a task row open their drill-down; Escape closes it', async ({ page }) => {
    const found = await openAnalysis(page);
    // Anywhere on the row opens it, not only the name.
    await rowsOf(page).filter({ hasText: 'Brand refresh' }).locator('.a-share-fig').click();
    await expect(drill(page, 'Brand refresh')).toBeVisible();
    await expect(drill(page, 'Brand refresh')).toContainText('exact');
    await page.keyboard.press('Escape');
    await expect(drill(page, 'Brand refresh')).toBeHidden();

    await setView(page, 'Tasks');
    await legend(page).getByRole('button', { name: 'Logo concepts, project Brand refresh', exact: true }).click();
    await expect(drill(page, 'Logo concepts')).toBeVisible();
    await expect(drill(page, 'Logo concepts')).toContainText('8h 30m exact');
    await page.keyboard.press('Escape');
    await expect(drill(page, 'Logo concepts')).toBeHidden();

    // A slice opens the same drill-down.
    await clickSlice(page, 0);
    await expect(drill(page, 'Logo concepts')).toBeVisible();
    await page.keyboard.press('Escape');
    await expectClean(page, found);
  });

  test('Enter on a focused legend button opens the drill-down, and Tab shows a visible focus outline', async ({ page }) => {
    const found = await openAnalysis(page);
    for (const view of ['Projects', 'Tasks'] as const) {
      await setView(page, view);
      // Reach the legend the way a keyboard user does: from the switch, by Tab.
      await share(page).getByRole('radio', { name: view, exact: true }).focus();
      let reached = false;
      for (let i = 0; i < 12 && !reached; i += 1) {
        await page.keyboard.press('Tab');
        reached = await page.evaluate(() => document.activeElement?.closest('ul.a-share-legend') !== null && document.activeElement?.tagName === 'BUTTON');
      }
      expect(reached, `${view}: Tab reaches the legend`).toBe(true);
      const focused = page.locator(':focus');
      const style = await focused.evaluate((el) => {
        const s = getComputedStyle(el);
        return { style: s.outlineStyle, width: Number.parseFloat(s.outlineWidth), matches: el.matches(':focus-visible') };
      });
      expect(style.matches, `${view}: focus-visible`).toBe(true);
      expect(style.style, `${view}: outline style`).not.toBe('none');
      expect(style.width, `${view}: outline width`).toBeGreaterThanOrEqual(2);
      const title = view === 'Projects' ? 'Brand refresh' : 'Logo concepts';
      await expect(focused).toContainText(title);
      await page.keyboard.press('Enter');
      await expect(drill(page, title)).toBeVisible();
      await page.keyboard.press('Escape');
      await expect(drill(page, title)).toBeHidden();
    }
    await expectClean(page, found);
  });

  test('Tab walks the rows in order and skips the slices; the Other row is not a stop', async ({ page }) => {
    const found = await openAnalysis(page, 'seed=many-tasks');
    await setView(page, 'Tasks');
    const buttons = legend(page).getByRole('button');
    await expect(buttons).toHaveCount(8);
    await buttons.first().focus();
    const seen: string[] = [];
    for (let i = 0; i < 8; i += 1) {
      seen.push((await page.evaluate(() => document.activeElement?.getAttribute('aria-label') ?? '')) || '?');
      if (i < 7) await page.keyboard.press('Tab');
    }
    const expected = (await readRows(page)).slice(0, 8).map((r) => `${r.name}, project ${r.project}`);
    expect(seen).toEqual(expected);
    // Past the last task button, focus has left the legend (Other is plain text).
    await page.keyboard.press('Tab');
    expect(await page.evaluate(() => document.activeElement?.closest('ul.a-share-legend') ?? null)).toBeNull();
    // Clicking the Other row opens nothing.
    await rowsOf(page).last().click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expectClean(page, found);
  });
});

test.describe('View data', () => {
  test('Projects: the project columns and one row per project; Tasks: its own columns and one row per task', async ({ page }) => {
    const found = await openAnalysis(page);
    await share(page).locator('summary', { hasText: 'View data' }).click();
    const table = share(page).getByRole('table');
    await expect(table).toBeVisible();
    expect(await table.locator('thead th').allTextContents()).toEqual(['Project', 'Billable', 'Share', 'Exact', 'Billable', 'Tasks', 'Average per task', 'Change vs previous', 'Pricing']);
    expect(await table.locator('tbody tr th').allTextContents()).toEqual(['Brand refresh', 'Website', 'Packaging', 'Admin']);

    await setView(page, 'Tasks');
    await expect(table.locator('thead th').first()).toHaveText('Task');
    expect(await table.locator('thead th').allTextContents()).toEqual(['Task', 'Project', 'Billable', 'Share', 'Exact', 'Billable']);
    expect((await table.locator('tbody tr th').allTextContents()).sort()).toEqual(['Box dieline', 'Brand guidelines', 'Email and invoices', 'Homepage layout', 'Logo concepts']);

    await setBasis(page, 'Exact');
    expect(await table.locator('thead th').allTextContents()).toEqual(['Task', 'Project', 'Exact', 'Share', 'Exact', 'Billable']);
    await expectClean(page, found);
  });

  test('the Tasks table lists every task, also the ones the legend groups into Other', async ({ page }) => {
    const found = await openAnalysis(page, 'seed=many-tasks');
    await setView(page, 'Tasks');
    await share(page).locator('summary', { hasText: 'View data' }).click();
    const table = share(page).getByRole('table');
    await expect(table.locator('tbody tr')).toHaveCount(10);
    const names = await table.locator('tbody tr th').allTextContents();
    const legendNames = (await readRows(page)).filter((r) => r.project !== null).map((r) => r.name);
    expect(legendNames).toHaveLength(8);
    for (const n of legendNames) expect(names).toContain(n);
    expect(names).toEqual(expect.arrayContaining(['Label artwork', 'Bug triage']));
    expect(names.filter((n) => !legendNames.includes(n)).sort()).toEqual(['Bug triage', 'Label artwork']);
    // Each row names its project.
    const label = table.locator('tbody tr', { has: page.getByRole('rowheader', { name: 'Bug triage', exact: true }) });
    await expect(label.getByRole('cell').first()).toHaveText('Website');
    await setView(page, 'Projects');
    await expect(table.locator('tbody tr')).toHaveCount(4);
    await expectClean(page, found);
  });
});

test.describe('Hide earnings', () => {
  test('does not hide the chart: names, hours, percentages and the centre stay', async ({ page }) => {
    const found = await openAnalysis(page, 'seed=demo&hide=1');
    // The setting is on: money elsewhere is masked.
    await expect(page.getByRole('article', { name: 'Earnings', exact: true })).toContainText('••••');
    for (const view of ['Projects', 'Tasks'] as const) {
      await setView(page, view);
      await expect(legend(page)).toBeVisible();
      await expect(centre(page)).toHaveText('24h 15m');
      await expect(donut(page)).toBeVisible();
      await expect(share(page)).not.toContainText('••••');
      const rows = await readRows(page);
      expect(figures(rows)).toEqual(view === 'Projects' ? DEMO_BILLABLE_PROJECTS : DEMO_BILLABLE_TASKS);
      for (let i = 0; i < rows.length; i += 1) await expect(rowsOf(page).nth(i)).toBeVisible();
    }
    await share(page).locator('summary', { hasText: 'View data' }).click();
    await expect(share(page).getByRole('table')).not.toContainText('••••');
    await expectClean(page, found);
  });
});

test.describe('Hide earnings at the new levels', () => {
  test('does not hide anything at Subtasks and Tags: hours are not earnings', async ({ page }) => {
    const found = await openAnalysis(page, 'seed=many-tasks&hide=1');
    await expect(page.getByRole('article', { name: 'Earnings', exact: true })).toContainText('••••');
    for (const view of ['Subtasks', 'Tags'] as const) {
      await setView(page, view);
      await expect(legend(page)).toBeVisible();
      await expect(donut(page)).toBeVisible();
      await expect(share(page)).not.toContainText('••••');
      const rows = await readRows(page);
      expect(rows.length).toBe(view === 'Subtasks' ? 9 : 7);
      for (const r of rows) expect(r.fig).toMatch(FIG);
    }
    await share(page).locator('summary', { hasText: 'View data' }).click();
    await expect(share(page).getByRole('table')).not.toContainText('••••');
    await expectClean(page, found);
  });
});

test.describe('themes', () => {
  for (const theme of THEMES) {
    test(`renders in ${theme} without console errors, all four levels`, async ({ page }) => {
      const found = await openAnalysis(page, `seed=many-tasks&theme=${theme}`);
      await expect(page.locator('html')).toHaveAttribute('data-theme', /./);
      for (const view of ['Projects', 'Tasks', 'Subtasks', 'Tags'] as const) {
        await setView(page, view);
        await expect(legend(page)).toBeVisible();
        await expect(donut(page)).toBeVisible();
        const rows = await readRows(page);
        expect(rows.length).toBe({ Projects: 4, Tasks: 9, Subtasks: 9, Tags: 7 }[view]);
        for (const r of rows) expect(r.fig).toMatch(FIG);
        // Legend text must be readable: not the colour of the card behind it.
        const colours = await legend(page).evaluate((ul) => {
          const li = ul.querySelector('li') as Element;
          const card = ul.closest('article') as Element;
          return { text: getComputedStyle(li).color, card: getComputedStyle(card).backgroundColor };
        });
        expect(colours.text).not.toBe(colours.card);
      }
      await expectClean(page, found);
    });
  }
});


// ---------------------------------------------------------------------------------------------- the four levels

// Exact basis in the week 9-15 Mar 2026 of `?seed=many-tasks`, in minutes (the seed's own header says where each comes from):
//   Brand refresh 1010: Logo concepts 510 (Moodboard 140, Sketches 205, Final artwork 85, none 80), Brand guidelines 365
//   (Outline 290, Review 75), Pitch deck 90 (Slides 90), Colour study 45.   Website 435: Homepage layout 365, Landing copy 60, Bug triage 10.
//   Packaging 170: Box dieline 150, Label artwork 20.   Admin 20: Email and invoices.    1635 minutes in all, 27h 15m.
const LOGO_SUBTASKS = ['Sketches 3h 25m (40%)', 'Moodboard 2h 20m (27%)', 'Final artwork 1h 25m (17%)', 'Logo concepts (no subtask) 1h 20m (16%)'];
const WEEK_TAGS = [
  'Concept 9h 15m (34%)',
  'Revision 7h 05m (26%)',
  'Concept + Revision 6h 05m (22%)',
  'Concept + Revision + Client call 2h 30m (9%)',
  'Concept + Client call 1h 30m (6%)',
  'No tag 0h 30m (2%)',
  'Admin 0h 20m (1%)',
];

test.describe('the four levels', () => {
  test('the switch has Projects, Tasks, Subtasks and Tags, and starts on Projects with no filter', async ({ page }) => {
    const found = await openAnalysis(page, 'seed=many-tasks');
    const group = share(page).getByRole('radiogroup', { name: 'Share of time by' });
    await expect(group.getByRole('radio')).toHaveText(['Projects', 'Tasks', 'Subtasks', 'Tags']);
    await expectView(page, 'Projects');
    await expect(group.getByRole('radio', { name: 'Subtasks', exact: true })).toBeEnabled();
    await expectClean(page, found);
  });

  test('Subtasks is switched off, with a tooltip, where no time is logged on a subtask, and the arrow keys pass over it', async ({ page }) => {
    const found = await openAnalysis(page, 'seed=demo');
    const subtasks = share(page).getByRole('radio', { name: 'Subtasks', exact: true });
    await expect(subtasks).toBeDisabled();
    await expect(subtasks).toHaveAttribute('title', 'No subtask time in this period');
    await expect(subtasks).toHaveAttribute('aria-checked', 'false');
    await share(page).getByRole('radio', { name: 'Tasks', exact: true }).click();
    await page.keyboard.press('ArrowRight');
    await expect(share(page).getByRole('radio', { name: 'Tags', exact: true })).toBeChecked();
    await expect(share(page).getByRole('radio', { name: 'Tags', exact: true })).toBeFocused();
    // Never an empty chart: the legend of the level that is on has its rows.
    expect((await readRows(page)).length).toBeGreaterThan(0);
    await expectClean(page, found);
  });

  test('the donut and the legend are named for each level', async ({ page }) => {
    const found = await openAnalysis(page, 'seed=many-tasks');
    for (const [view, noun] of [['Projects', 'project'], ['Tasks', 'task'], ['Subtasks', 'subtask'], ['Tags', 'tag']] as const) {
      await setView(page, view);
      await expect(donut(page)).toHaveAttribute('aria-label', `Share of time per ${noun}`);
      await expect(share(page).getByRole('list', { name: `Share of time legend, ${view.toLowerCase()}` })).toBeVisible();
    }
    await expectClean(page, found);
  });

  test('every level adds up to 100% and to the same total in the centre, in both bases', async ({ page }) => {
    const found = await openAnalysis(page, 'seed=many-tasks');
    for (const basis of ['Exact', 'Billable'] as const) {
      await setBasis(page, basis);
      const centres: string[] = [];
      for (const view of ['Projects', 'Tasks', 'Subtasks', 'Tags'] as const) {
        await setView(page, view);
        const rows = await readRows(page);
        const where = `${basis} ${view}`;
        expect(sum(rows.map((r) => percentOf(r.pct))), `${where}: percentages`).toBe(100);
        const total = minutesOf(((await centre(page).textContent()) ?? '').trim());
        expect(sum(rows.map((r) => minutesOf(r.hm))), `${where}: minutes against centre`).toBe(total);
        for (const r of rows) expect(r.fig, where).toMatch(FIG);
        centres.push(((await centre(page).textContent()) ?? '').trim());
      }
      expect(new Set(centres).size, `${basis}: one total at every level, got ${centres.join(', ')}`).toBe(1);
    }
    await expectClean(page, found);
  });
});

test.describe('the level follows the filter', () => {
  test('one project: Tasks, the task’s name alone, and the whole path in the title, the button and the slice', async ({ page }) => {
    const found = await openAnalysis(page, 'seed=many-tasks');
    await setBasis(page, 'Exact');
    await chooseProject(page, 'Website');
    await expectView(page, 'Tasks');
    await expect(legend(page)).toHaveAttribute('aria-label', 'Share of time legend, tasks');
    const rows = await readRows(page);
    expect(figures(rows)).toEqual(['Homepage layout 6h 05m (84%)', 'Landing copy 1h 00m (14%)', 'Bug triage 0h 10m (2%)']);
    for (const r of rows) {
      expect(r.context, `${r.name}: nothing after the name`).toEqual([]);
      expect(r.title).toBe(`Website > ${r.name}`);
      expect(r.buttonLabel).toBe(`${r.name}, project Website`);
    }
    await expect(legend(page).locator('.a-share-sep')).toHaveCount(0);
    await expect(donut(page).locator('path.a-slice').first()).toHaveAttribute('aria-label', 'Website > Homepage layout: 6h 05m (84%)');
    await expect(legend(page).getByRole('button', { name: 'Homepage layout, project Website', exact: true })).toBeVisible();
    await expectClean(page, found);
  });

  test('a second project: back to Projects', async ({ page }) => {
    const found = await openAnalysis(page, 'seed=many-tasks');
    await chooseProject(page, 'Website');
    await expectView(page, 'Tasks');
    await chooseProject(page, 'Packaging');
    await expectView(page, 'Projects');
    await setBasis(page, 'Exact');
    await expectFigures(page, ['Website 7h 15m (72%)', 'Packaging 2h 50m (28%)']);
    await expectClean(page, found);
  });

  test('one task: Subtasks, the subtask’s name alone, and the task’s time on none as "<Task> (no subtask)"', async ({ page }) => {
    const found = await openAnalysis(page, 'seed=many-tasks');
    await setBasis(page, 'Exact');
    await chooseTask(page, 'Logo concepts');
    await expectView(page, 'Subtasks');
    await expect(legend(page)).toHaveAttribute('aria-label', 'Share of time legend, subtasks');
    await expect(donut(page)).toHaveAttribute('aria-label', 'Share of time per subtask');
    const rows = await readRows(page);
    expect(figures(rows)).toEqual(LOGO_SUBTASKS);
    await expect(centre(page)).toHaveText('8h 30m');
    for (const r of rows) expect(r.context, `${r.name}: nothing after the name`).toEqual([]);
    expect(rows.map((r) => r.title)).toEqual([
      'Brand refresh > Logo concepts > Sketches',
      'Brand refresh > Logo concepts > Moodboard',
      'Brand refresh > Logo concepts > Final artwork',
      'Brand refresh > Logo concepts > (no subtask)',
    ]);
    expect(rows.map((r) => r.buttonLabel)).toEqual([
      'Sketches, task Logo concepts, project Brand refresh',
      'Moodboard, task Logo concepts, project Brand refresh',
      'Final artwork, task Logo concepts, project Brand refresh',
      'Logo concepts (no subtask), project Brand refresh',
    ]);
    await expect(donut(page).locator('path.a-slice').first()).toHaveAttribute('aria-label', 'Brand refresh > Logo concepts > Sketches: 3h 25m (40%)');
    // Subtasks of one task are shades of the project's colour, each different.
    expect(new Set(rows.map((r) => r.swatch)).size).toBe(4);
    await expectClean(page, found);
  });

  test('the project of the task as well: still Subtasks', async ({ page }) => {
    const found = await openAnalysis(page, 'seed=many-tasks');
    await chooseProject(page, 'Brand refresh');
    await expectView(page, 'Tasks');
    await chooseTask(page, 'Logo concepts');
    await expectView(page, 'Subtasks');
    await expectClean(page, found);
  });

  test('a task with no subtask time falls back to Tasks and switches Subtasks off', async ({ page }) => {
    const found = await openAnalysis(page, 'seed=many-tasks');
    await setBasis(page, 'Exact');
    await chooseTask(page, 'Homepage layout');
    await expectView(page, 'Tasks');
    const subtasks = share(page).getByRole('radio', { name: 'Subtasks', exact: true });
    await expect(subtasks).toBeDisabled();
    await expect(subtasks).toHaveAttribute('title', 'No subtask time in this period');
    await expectFigures(page, ['Homepage layout 6h 05m (100%)']);
    // Another task with subtask time: Subtasks comes back, as the level the filter asks for.
    await chooseTask(page, 'Brand guidelines');
    await expectView(page, 'Subtasks');
    await expect(subtasks).toBeEnabled();
    await expectFigures(page, ['Outline 4h 50m (79%)', 'Review 1h 15m (21%)']);
    await expectClean(page, found);
  });

  test('a name search that leaves one task asks for Subtasks, as one task chosen does, and clearing it goes back', async ({ page }) => {
    const found = await openAnalysis(page, 'seed=many-tasks');
    await setBasis(page, 'Exact');
    // The Timeline's task filter has a box with the same name; this one is in the Analysis controls.
    const search = controls(page).getByRole('searchbox', { name: 'Search tasks by name or description' });
    await search.fill('Logo');
    // The search waits for a pause in the typing; the page clock is paused in these specs, so let it run on.
    await page.clock.runFor(300);
    await expect(page.getByTestId('analysis-search-status')).toHaveText('1 task matches');
    await expectView(page, 'Subtasks');
    await expectFigures(page, LOGO_SUBTASKS);
    await search.fill('');
    await page.clock.runFor(300);
    await expect(page.getByTestId('analysis-search-status')).toHaveCount(0);
    await expectView(page, 'Projects');
    await expectClean(page, found);
  });

  test('a level picked by hand survives the next change of the default, and the default applies again after that', async ({ page }) => {
    const found = await openAnalysis(page, 'seed=many-tasks');
    await setView(page, 'Tags');
    await chooseProject(page, 'Website');
    await expectView(page, 'Tags'); // the pick survives the change to one project
    await chooseProject(page, 'Packaging');
    await expectView(page, 'Projects'); // the next change of the default applies it again
    await expectClean(page, found);
  });

  test('a tag filter does not move the level, and does not undo a pick', async ({ page }) => {
    const found = await openAnalysis(page, 'seed=many-tasks');
    await expectView(page, 'Projects');
    await chooseTag(page, 'Concept');
    await expectView(page, 'Projects');
    await setView(page, 'Tags');
    await chooseTag(page, 'Revision');
    await chooseTag(page, 'No tag');
    await expectView(page, 'Tags');
    await expectClean(page, found);
  });
});

test.describe('what a row says', () => {
  test('Tasks with several projects in the data: the task, then its project in muted text', async ({ page }) => {
    const found = await openAnalysis(page, 'seed=many-tasks');
    await setView(page, 'Tasks');
    const rows = (await readRows(page)).filter((r) => !r.name.startsWith('Other'));
    expect(rows.length).toBe(8);
    for (const r of rows) {
      expect(r.context).toHaveLength(1);
      expect(r.title).toBe(`${r.project} > ${r.name}`);
    }
    expect(rows[0]).toMatchObject({ name: 'Logo concepts', context: ['Brand refresh'] });
    await expect(legend(page).locator('.a-share-sep').first()).toHaveAttribute('aria-hidden', 'true');
    await expectClean(page, found);
  });

  test('Subtasks across the tasks of several projects: the subtask, its task, its project; "(no subtask)" names its project only; the rest is Other (N subtasks)', async ({ page }) => {
    const found = await openAnalysis(page, 'seed=many-tasks');
    await setBasis(page, 'Exact');
    await setView(page, 'Subtasks');
    const rows = await readRows(page);
    expect(rows).toHaveLength(9);
    expect(rows[0]).toMatchObject({ name: 'Sketches', context: ['Logo concepts', 'Brand refresh'], title: 'Brand refresh > Logo concepts > Sketches' });
    const none = rows.find((r) => r.name === 'Homepage layout (no subtask)');
    expect(none).toMatchObject({ context: ['Website'], title: 'Website > Homepage layout > (no subtask)', buttonLabel: 'Homepage layout (no subtask), project Website' });
    const other = rows.at(-1) as Row;
    expect(other.name).toBe('Other (6 subtasks)');
    expect(other).toMatchObject({ hasButton: false, open: false, context: [] });
    await expect(share(page).getByText('Other adds up the 6 subtasks with the least time. View data lists every subtask.')).toBeVisible();
    // The table lists every subtask: the 14 with time, with the whole path in three columns.
    await share(page).locator('summary', { hasText: 'View data' }).click();
    const table = share(page).getByRole('table');
    await expect(table).toBeVisible();
    expect(await table.locator('thead th').allTextContents()).toEqual(['Subtask', 'Task', 'Project', 'Exact', 'Share', 'Exact', 'Billable']);
    await expect(table.locator('tbody tr')).toHaveCount(14);
    // Most time first, like the legend's rows before they are grouped: Homepage layout's 6h 05m on no subtask leads.
    await expect(table.locator('tbody tr').first().locator('th')).toHaveText('(no subtask)');
    const sketches = table.locator('tbody tr', { has: page.getByRole('rowheader', { name: 'Sketches', exact: true }) });
    await expect(sketches.getByRole('cell')).toHaveText(['Logo concepts', 'Brand refresh', '3:25:00', '12.5%', '3:25:00', /^3:3\d:\d\d$/]);
    await expect(table.locator('tbody tr th', { hasText: '(no subtask)' })).toHaveCount(8);
    await expectClean(page, found);
  });

  test('Subtasks across the tasks of one project: the subtask and its task, no project', async ({ page }) => {
    const found = await openAnalysis(page, 'seed=many-tasks');
    await setBasis(page, 'Exact');
    await chooseProject(page, 'Brand refresh');
    await setView(page, 'Subtasks');
    const rows = await readRows(page);
    expect(rows.map((r) => [r.name, ...r.context])).toEqual([
      ['Sketches', 'Logo concepts'],
      ['Moodboard', 'Logo concepts'],
      ['Final artwork', 'Logo concepts'],
      ['Logo concepts (no subtask)'],
      ['Outline', 'Brand guidelines'],
      ['Review', 'Brand guidelines'],
      ['Slides', 'Pitch deck'],
      ['Colour study (no subtask)'],
    ]);
    expect(rows[0]?.title).toBe('Brand refresh > Logo concepts > Sketches');
    await expect(legend(page).getByRole('button', { name: 'Slides, task Pitch deck, project Brand refresh', exact: true })).toBeVisible();
    await expectClean(page, found);
  });
});

test.describe('the Tags level', () => {
  test('has a row per combination, named in the Settings order, with "No tag" for untagged time; Box dieline was tagged out of order', async ({ page }) => {
    const found = await openAnalysis(page, 'seed=many-tasks');
    await setBasis(page, 'Exact');
    await setView(page, 'Tags');
    const rows = await readRows(page);
    expect(figures(rows)).toEqual(WEEK_TAGS);
    await expect(centre(page)).toHaveText('27h 15m');
    expect(sum(rows.map((r) => percentOf(r.pct)))).toBe(100);
    expect(rows.every((r) => r.title === r.name)).toBe(true);
    expect(rows.every((r) => r.context.length === 0)).toBe(true);
    await expectClean(page, found);
  });

  test('draws a combination as stripes of its tags’ colours, in the legend and on the donut, and a single tag in its colour', async ({ page }) => {
    const found = await openAnalysis(page, 'seed=many-tasks');
    await setView(page, 'Tags');
    const rows = await readRows(page);
    expect(rows.map((r) => r.stripes)).toEqual([null, null, '2', '3', '2', null, null]);
    const fills = await donut(page).locator('path.a-slice').evaluateAll((els) => els.map((e) => getComputedStyle(e).fill));
    rows.forEach((r, i) => {
      if (r.stripes === null) expect(fills[i], `${r.name}: a single colour, the swatch's`).toBe(r.swatch);
      else expect(fills[i], `${r.name}: a pattern`).toMatch(/^url\(/);
    });
    // One pattern per combination, a stripe per tag in the Settings order: Concept, Revision, Client call.
    const patterns = await donut(page).locator('pattern').evaluateAll((els) => els.map((p) => [...p.querySelectorAll('rect')].map((r) => r.getAttribute('fill'))));
    expect(patterns).toEqual([
      ['#7c3aed', '#0f766e'],
      ['#7c3aed', '#0f766e', '#c2410c'],
      ['#7c3aed', '#c2410c'],
    ]);
    // The swatch of a combination is not one flat colour: its gradient names every tag's colour.
    const image = await legend(page).locator('li').nth(3).locator('.a-share-swatch').evaluate((el) => getComputedStyle(el).backgroundImage);
    expect(image).toContain('repeating-linear-gradient');
    for (const c of ['rgb(124, 58, 237)', 'rgb(15, 118, 110)', 'rgb(194, 65, 12)']) expect(image).toContain(c);
    await expectClean(page, found);
  });

  test('says under the legend that a task with several tags is counted once, under its combination, and only when one is', async ({ page }) => {
    const found = await openAnalysis(page, 'seed=many-tasks');
    const note = share(page).getByText('Tasks with several tags are counted once, under their combination.');
    await expect(note).toHaveCount(0);
    await setView(page, 'Tags');
    await expect(note).toBeVisible();
    // Only tasks with one tag or none (the tag filter keeps Admin's): nothing to explain.
    await chooseTag(page, 'Admin');
    await expect(note).toHaveCount(0);
    await expectFigures(page, ['Admin 0h 30m (100%)']);
    await setView(page, 'Tasks');
    await expect(note).toHaveCount(0);
    await expectClean(page, found);
  });

  test('the View data table lists every combination with the number of tasks', async ({ page }) => {
    const found = await openAnalysis(page, 'seed=many-tasks');
    await setBasis(page, 'Exact');
    await setView(page, 'Tags');
    await share(page).locator('summary', { hasText: 'View data' }).click();
    const table = share(page).getByRole('table');
    await expect(table).toBeVisible();
    expect(await table.locator('thead th').allTextContents()).toEqual(['Tags', 'Exact', 'Share', 'Exact', 'Billable', 'Tasks']);
    expect(await table.locator('tbody tr th').allTextContents()).toEqual(['Concept', 'Revision', 'Concept + Revision', 'Concept + Revision + Client call', 'Concept + Client call', 'No tag', 'Admin']);
    await expect(table.locator('tbody tr').first().getByRole('cell')).toHaveText(['9:15:00', '33.9%', '9:15:00', '9:30:00', '2']);
    await expectClean(page, found);
  });
});

test.describe('the "No tag" choice of the tag filter', () => {
  test('is the last choice, and with nothing chosen every task is kept', async ({ page }) => {
    const found = await openAnalysis(page, 'seed=many-tasks');
    await expect(tagFilter(page).getByRole('checkbox')).toHaveCount(5);
    expect(await tagFilter(page).locator('label').allTextContents()).toEqual(['Concept', 'Revision', 'Client call', 'Admin', 'No tag']);
    await expect(tagFilter(page).locator('.a-tag-hint')).toHaveText('All tasks; whole tasks are kept, so Billable stays available.');
    await expect(centre(page)).toHaveText('28h 15m');
    await expectClean(page, found);
  });

  test('alone keeps only the time of tasks with no tag, in every figure on the page', async ({ page }) => {
    const found = await openAnalysis(page, 'seed=many-tasks');
    await setBasis(page, 'Exact');
    await chooseTag(page, 'No tag');
    await expect(tagFilter(page).locator('.a-tag-hint')).toHaveText('Tasks with no tag; whole tasks are kept, so Billable stays available.');
    // The donut: Label artwork (Packaging, 20 min) and Bug triage (Website, 10 min).
    await expect(centre(page)).toHaveText('0h 30m');
    await expectFigures(page, ['Packaging 0h 20m (67%)', 'Website 0h 10m (33%)']);
    await setView(page, 'Tasks');
    await expectFigures(page, ['Label artwork 0h 20m (67%)', 'Bug triage 0h 10m (33%)']);
    await setView(page, 'Tags');
    await expectFigures(page, ['No tag 0h 30m (100%)']);
    // Other parts of the page follow it: the ranked projects and the key figures.
    await expect(page.getByRole('img', { name: 'Projects ranked by time' })).toContainText('Packaging');
    await expect(page.getByRole('img', { name: 'Projects ranked by time' })).not.toContainText('Brand refresh');
    await expect(page.getByRole('list', { name: 'Key figures' })).toContainText('Exact 30m');
    await expectClean(page, found);
  });

  test('with a tag keeps both, a tag alone keeps its tasks, and the level stays where it was', async ({ page }) => {
    const found = await openAnalysis(page, 'seed=many-tasks');
    await setBasis(page, 'Exact');
    await chooseTag(page, 'Admin');
    await expect(centre(page)).toHaveText('0h 20m');
    await expect(tagFilter(page).locator('.a-tag-hint')).toHaveText('Tasks with any selected tag; whole tasks are kept, so Billable stays available.');
    await chooseTag(page, 'No tag');
    await expect(centre(page)).toHaveText('0h 50m');
    await expect(tagFilter(page).locator('.a-tag-hint')).toHaveText('Tasks with any selected tag, or with no tag; whole tasks are kept, so Billable stays available.');
    await expectView(page, 'Projects');
    await setView(page, 'Tags');
    await expectFigures(page, ['No tag 0h 30m (60%)', 'Admin 0h 20m (40%)']);
    await expectClean(page, found);
  });

  test('keeps a task’s full set of tags in the Tags rows when a tag is chosen', async ({ page }) => {
    const found = await openAnalysis(page, 'seed=many-tasks');
    await setBasis(page, 'Exact');
    await chooseTag(page, 'Client call');
    await setView(page, 'Tags');
    // Box dieline (Concept + Revision + Client call, 150) and Pitch deck (Concept + Client call, 90) carry Client call.
    await expectFigures(page, ['Concept + Revision + Client call 2h 30m (63%)', 'Concept + Client call 1h 30m (37%)']);
    await expectClean(page, found);
  });

  test('is cleared with the other filters, and unchecking it keeps every task again', async ({ page }) => {
    const found = await openAnalysis(page, 'seed=many-tasks');
    await chooseTag(page, 'No tag');
    await expect(centre(page)).not.toHaveText('28h 15m');
    await page.getByRole('button', { name: 'Clear filters' }).click();
    await expect(tagFilter(page).getByRole('checkbox', { name: 'No tag', exact: true })).not.toBeChecked();
    await expect(centre(page)).toHaveText('28h 15m');
    await tagFilter(page).getByRole('checkbox', { name: 'No tag', exact: true }).check();
    await tagFilter(page).getByRole('checkbox', { name: 'No tag', exact: true }).uncheck();
    await expect(centre(page)).toHaveText('28h 15m');
    await expectClean(page, found);
  });
});

test.describe('click-through at the new levels', () => {
  const drill = (page: Page, title: string): Locator => page.getByRole('dialog', { name: `Drill-down: ${title}` });

  test('a subtask row opens the time behind it, and the row for none opens the task’s time on none', async ({ page }) => {
    const found = await openAnalysis(page, 'seed=many-tasks');
    await setBasis(page, 'Exact');
    await chooseTask(page, 'Logo concepts');
    await legend(page).getByRole('button', { name: 'Sketches, task Logo concepts, project Brand refresh', exact: true }).click();
    await expect(drill(page, 'Sketches')).toBeVisible();
    await expect(drill(page, 'Sketches')).toContainText('3h 25m exact');
    await page.keyboard.press('Escape');
    await expect(drill(page, 'Sketches')).toBeHidden();
    await legend(page).getByRole('button', { name: 'Logo concepts (no subtask), project Brand refresh', exact: true }).click();
    await expect(drill(page, 'Logo concepts (no subtask)')).toBeVisible();
    await expect(drill(page, 'Logo concepts (no subtask)')).toContainText('1h 20m exact');
    await page.keyboard.press('Escape');
    // A slice opens the same panel.
    await clickSlice(page, 1);
    await expect(drill(page, 'Moodboard')).toBeVisible();
    await expect(drill(page, 'Moodboard')).toContainText('2h 20m exact');
    await expectClean(page, found);
  });

  test('a combination row opens the tasks it counts', async ({ page }) => {
    const found = await openAnalysis(page, 'seed=many-tasks');
    await setBasis(page, 'Exact');
    await setView(page, 'Tags');
    await legend(page).getByRole('button', { name: 'Concept + Revision', exact: true }).click();
    await expect(drill(page, 'Concept + Revision')).toBeVisible();
    await expect(drill(page, 'Concept + Revision')).toContainText('6h 05m exact');
    await expect(drill(page, 'Concept + Revision').getByRole('list').first()).toContainText('Brand guidelines');
    await page.keyboard.press('Escape');
    await legend(page).getByRole('button', { name: 'No tag', exact: true }).click();
    await expect(drill(page, 'No tag')).toContainText('30m exact');
    await expectClean(page, found);
  });
});

// Pictures of the card for the owner. They go to ZWT_SHOT_DIR when it is set, else to test-results/screenshots.
test.describe('card pictures', () => {
  test.use({ viewport: { width: 1320, height: 900 } });
  type Shot = { name: string; theme: 'light' | 'dark'; view: View; seed: string; task?: string };
  const shots: Shot[] = [];
  for (const theme of ['light', 'dark'] as const) {
    shots.push(
      { name: `share-${theme}-projects`, theme, view: 'Projects', seed: 'demo' },
      { name: `share-${theme}-tasks`, theme, view: 'Tasks', seed: 'demo' },
      { name: `share-${theme}-tasks-other`, theme, view: 'Tasks', seed: 'many-tasks' },
      // One task chosen: the card starts on Subtasks by itself.
      { name: `share-${theme}-subtasks`, theme, view: 'Subtasks', seed: 'many-tasks', task: 'Logo concepts' },
      { name: `share-${theme}-tags`, theme, view: 'Tags', seed: 'many-tasks' },
    );
  }
  for (const s of shots) {
    test(s.name, async ({ page }) => {
      const found = await openAnalysis(page, `seed=${s.seed}&theme=${s.theme}`);
      if (s.task) {
        await chooseTask(page, s.task);
        await expect(share(page).getByRole('radio', { name: s.view, exact: true })).toBeChecked();
      } else await setView(page, s.view);
      await expect(legend(page)).toBeVisible();
      await share(page).scrollIntoViewIfNeeded();
      await page.mouse.move(0, 0);
      await share(page).screenshot({ path: path.join(SHOTS, `${s.name}.png`) });
      await expectClean(page, found);
    });
  }
});
