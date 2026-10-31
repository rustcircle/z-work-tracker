// The Metrics reference: every figure the screen, the insights and the Excel sheets point at has an entry,
// and the phase 2 entries say what the spec requires.
import { describe, expect, it } from 'vitest';

import { GLOSSARY, glossaryEntry, searchGlossary } from './glossary';

const sources = import.meta.glob<string>(['/src/**/*.{ts,tsx}', '!/src/**/*.test.{ts,tsx}', '!/src/**/*.perf.test.ts', '!/src/features/analysis/glossary*.ts'], { query: '?raw', import: 'default', eager: true });

/** Ids a source file points at: `info="x.y"`, `info: 'x.y'`, `openGlossary('x.y')` and metric lists in the insights and sheets. */
function referencedIds(): Map<string, string[]> {
  const found = new Map<string, string[]>();
  const add = (id: string, file: string): void => void found.set(id, [...(found.get(id) ?? []), file]);
  const family = /^(basis|(filters|volume|time|projects|tasks|focus|consistency|goals|money|forecast|shifts|zones|pauses|subtasks|tags|budget|billing)\.\w+)$/;
  for (const [file, text] of Object.entries(sources)) {
    for (const m of text.matchAll(/\binfo[=:]\s*[{]?\s*["']([\w.]+)["']/g)) add(m[1] as string, file);
    for (const m of text.matchAll(/<InfoButton[^>]*\bid=["']([\w.]+)["']/g)) add(m[1] as string, file);
    for (const m of text.matchAll(/openGlossary\(\s*["']([\w.]+)["']\s*\)/g)) add(m[1] as string, file);
    if (/analysis\/(insights|sheets)\.ts$/.test(file)) for (const m of text.matchAll(/["']([a-z]+(?:\.\w+)?)["']/g)) if (family.test(m[1] as string)) add(m[1] as string, file);
  }
  return found;
}

describe('glossary coverage', () => {
  it('has an entry for every metric id the UI, the insights and the sheets use', () => {
    const ids = referencedIds();
    expect(ids.size).toBeGreaterThan(30);
    const missing = [...ids].filter(([id]) => glossaryEntry(id) === undefined).map(([id, files]) => `${id} (${files[0] ?? ''})`);
    expect(missing).toEqual([]);
  });

  it('has unique ids and a definition, a formula and a basis for each entry', () => {
    expect(new Set(GLOSSARY.map((e) => e.id)).size).toBe(GLOSSARY.length);
    for (const e of GLOSSARY) {
      expect(e.definition.length, e.id).toBeGreaterThan(30);
      expect(e.formula.length, e.id).toBeGreaterThan(5);
      expect(['Exact', 'Billable', 'Follows the Basis switch', 'Neither']).toContain(e.basis);
    }
  });
});

describe('phase 2 entries', () => {
  const names: [string, string][] = [
    ['pauses.billable', 'Billable pause time'],
    ['time.thinking', 'Thinking time'],
    ['time.unconfirmed', 'Unconfirmed time'],
    ['subtasks.time', 'Subtask time'],
    ['tags.time', 'Time by tag'],
    ['money.fixedFeeRate', 'Effective hourly rate on a fixed fee'],
    ['budget.used', 'Budget used'],
    ['billing.billedUnbilled', 'Billed and unbilled time'],
    ['money.rounding', 'Rounding adjustment'],
  ];
  it.each(names)('%s is named %s', (id, name) => {
    expect(glossaryEntry(id)?.name).toBe(name);
  });

  it('says that pauses are in Billable and in the rounding adjustment but not in Exact', () => {
    expect(glossaryEntry('basis')?.definition).toMatch(/billable pauses[^.]*count in Billable and never in Exact/i);
    expect(glossaryEntry('money.rounding')?.definition).toMatch(/billable pauses[^.]*included in the adjustment/i);
    expect(glossaryEntry('money.rounding')?.formula).toContain('billable pauses');
    expect(glossaryEntry('pauses.billable')?.definition).toMatch(/not worked time/i);
    expect(glossaryEntry('pauses.billable')?.definition).toMatch(/neither the pause count nor the focus ratio/i);
  });

  it('says that unconfirmed time counts nowhere and that tags overlap', () => {
    expect(glossaryEntry('time.unconfirmed')?.definition).toMatch(/counts nowhere/i);
    expect(glossaryEntry('tags.time')?.definition).toMatch(/two tags counts fully in each/i);
    expect(glossaryEntry('tags.time')?.definition).toMatch(/no total across tags/i);
  });

  it('states the budget thresholds, rounding down and both bases', () => {
    const d = glossaryEntry('budget.used')?.definition ?? '';
    expect(d).toMatch(/rounded down/);
    expect(d).toMatch(/80%/);
    expect(d).toMatch(/100%|over budget/);
    expect(d).toMatch(/hours budget/);
    expect(d).toMatch(/fixed fee needs a price per hour/);
  });

  it('is found by the glossary search', () => {
    for (const q of ['billable pause', 'thinking', 'unconfirmed', 'subtask', 'by tag', 'fixed fee', 'budget used', 'billed']) {
      expect(searchGlossary(q).length, q).toBeGreaterThan(0);
    }
    expect(searchGlossary('unconfirmed').map((e) => e.id)).toContain('time.unconfirmed');
  });
});
