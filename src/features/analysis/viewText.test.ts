import { describe, expect, it } from 'vitest';

import { NO_FILTERS, OUTSIDE, type Filters } from './engine';
import { mkSnapshot } from './testkit';
import { historyScopeText } from './sheets';
import { filterText, viewScopeText } from './viewText';

const snap = mkSnapshot({
  now: '2026-03-12T12:00:00Z',
  projects: [{ id: 'p1', name: 'Website' }, { id: 'p2', name: 'Packaging' }, { id: 'p3', name: 'Admin' }, { id: 'p4', name: 'Print' }],
  tasks: [{ id: 'a', projectId: 'p1' }],
  tags: [{ id: 'g1', name: 'Urgent' }],
  shifts: [{ name: 'Morning' }],
});
const text = (f: Partial<Filters>): string => filterText(snap, { ...NO_FILTERS, ...f });

describe('filterText', () => {
  it('says nothing when no filter is on', () => {
    expect(text({})).toBe('');
    expect(text({ query: '   ' })).toBe('');
  });

  it('names a few projects and counts many', () => {
    expect(text({ projectIds: ['p1'] })).toBe('project Website');
    expect(text({ projectIds: ['p1', 'p2'] })).toBe('projects Website, Packaging');
    expect(text({ projectIds: ['p1', 'p2', 'p3', 'p4'] })).toBe('4 projects');
  });

  it('names a task, a tag, a band and a shift', () => {
    expect(text({ taskIds: ['a'] })).toBe('task Task a');
    expect(text({ tagIds: ['g1'] })).toBe('tag Urgent');
    expect(text({ band: 1 })).toBe('band Morning (06-12)');
    expect(text({ shiftKey: 'sh0' })).toBe('shift Morning');
    expect(text({ shiftKey: OUTSIDE })).toBe('outside any shift');
  });

  it('quotes the search', () => {
    expect(text({ query: ' logo ' })).toBe('search "logo"');
  });

  it('puts every filter that is on in one line', () => {
    expect(text({ projectIds: ['p1'], band: 2, query: 'logo' })).toBe('project Website; band Afternoon (12-18); search "logo"');
  });

  it('marks what has been deleted', () => {
    expect(text({ projectIds: ['gone'], taskIds: ['gone'], tagIds: ['gone'], shiftKey: 'gone' })).toBe('project (deleted); task (deleted); tag (deleted); shift (deleted)');
  });
});

describe('viewScopeText', () => {
  const view = { range: { kind: 'week', anchor: '2026-03-10' } as const, filters: NO_FILTERS, basis: 'exact' as const, compare: false };

  it('gives the period alone, or the period with its filters', () => {
    expect(viewScopeText(snap, view, 'UTC')).toBe('9 Mar – 15 Mar 2026');
    expect(viewScopeText(snap, { ...view, filters: { ...NO_FILTERS, projectIds: ['p1'] } }, 'UTC')).toBe('9 Mar – 15 Mar 2026, filtered to project Website');
  });

  it('says the filters as chosen when the view carries them apart from what the figures use', () => {
    const used = { ...NO_FILTERS, taskIds: ['__no-matching-task'], query: 'zzz' };
    expect(viewScopeText(snap, { ...view, filters: used, shown: { ...NO_FILTERS, query: 'zzz' } }, 'UTC')).toBe('9 Mar – 15 Mar 2026, filtered to search "zzz"');
  });
});

describe('historyScopeText', () => {
  const now = '2026-03-12T12:00:00Z';
  const withSegs = (segs: [string, string, string | null][]) => mkSnapshot({ now, projects: [{ id: 'p' }], tasks: [{ id: 't', projectId: 'p', state: 'stopped' }], segs });
  const at = (snapshot: ReturnType<typeof withSegs>): string => historyScopeText(snapshot, 'UTC', Date.parse(now) / 1000);

  it('says all logged history, from the first logged day to today', () => {
    expect(at(withSegs([['t', '2026-02-23T09:00:00Z', '2026-02-23T10:00:00Z']]))).toBe('all logged history: 23 Feb – 12 Mar 2026');
  });

  it('says so when only the latest 1830 days are covered', () => {
    expect(at(withSegs([['t', '2020-01-01T09:00:00Z', '2020-01-01T10:00:00Z']]))).toBe('the latest 1830 days: 9 Mar 2021 – 12 Mar 2026');
  });

  it('says the current week when nothing is logged', () => {
    expect(at(withSegs([]))).toBe('the current week, as nothing is logged yet: 9 Mar – 15 Mar 2026');
  });
});
