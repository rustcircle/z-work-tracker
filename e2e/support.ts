import { expect, type Locator, type Page } from '@playwright/test';

import type { MockState } from '../src/mocks/ipcMock';

// The demo seed: 12 March 2026 15:20 UTC, My zone Lisbon, Client zone New York.
export const DEMO_NOW = '2026-03-12T15:20:00Z';

declare global {
  interface Window {
    __mock: MockState;
    __mockRelaunch: (kind: 'quit' | 'crash') => void;
    __mockEmit: (event: string, payload?: unknown) => Promise<void>;
  }
}

export interface Violations {
  csp: string[];
  errors: string[];
}

/** Collects Content-Security-Policy violations (event and console) and page errors for the whole test. */
export async function watch(page: Page): Promise<Violations> {
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

export async function expectClean(page: Page, found: Violations): Promise<void> {
  const fromEvents = await page.evaluate(() => (window as unknown as { __csp?: string[] }).__csp ?? []);
  expect([...found.csp, ...fromEvents], 'CSP violations').toEqual([]);
  expect(found.errors, 'console errors').toEqual([]);
}

export async function open(page: Page, query: string, ready = true): Promise<Violations> {
  const found = await watch(page);
  await page.clock.install({ time: new Date(DEMO_NOW) });
  await page.goto(`/?${query}`);
  if (ready) await expect(page.getByRole('tab', { name: 'Timeline' })).toBeVisible();
  return found;
}

/** Makes the backend mock hand out a fresh snapshot, after a test edited its state directly. */
export async function refresh(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'UTC', exact: true }).click();
  await page.getByRole('button', { name: 'My time' }).click();
}

export const tab = (page: Page, name: string): Promise<void> => page.getByRole('tab', { name }).click();
export const card = (page: Page, name: string): Locator => page.getByRole('article', { name, exact: true });

/** Moves the mock backend's clock and the page's clock together. */
export async function advance(page: Page, secs: number): Promise<void> {
  await page.evaluate((s) => {
    window.__mock.now += s;
  }, secs);
  await page.clock.fastForward(secs * 1000);
}

