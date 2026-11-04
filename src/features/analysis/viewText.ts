// In words, what the Analysis tab's filters are: said in the title of each exported sheet and in the Export dialog,
// so a file never holds filtered figures without saying so.
import { groupVersions } from '../../lib/shifts';
import { BANDS } from '../../lib/split';
import type { Snapshot } from '../../lib/types';
import { OUTSIDE, type Filters } from './engine';
import { periodOf } from './range';
import { NO_TAG } from './tagFilter';
import type { AnalysisView } from './view';

const HOURS = ['00-06', '06-12', '12-18', '18-24'] as const;
/** Up to this many names are spelled out; more are counted. */
const MOST_NAMES = 3;

/** "project Website", "projects Website, Print run", or "5 projects". */
function listText(one: string, many: string, names: readonly string[]): string {
  if (names.length === 1) return `${one} ${names[0]}`;
  return names.length <= MOST_NAMES ? `${many} ${names.join(', ')}` : `${names.length} ${many}`;
}

/** The filters in words ("project Website; band Morning (06-12)"), or an empty string when none is on. */
export function filterText(snapshot: Snapshot, filters: Filters): string {
  const parts: string[] = [];
  const named = (ids: readonly string[], items: readonly { id: string; name: string }[], gone: string): string[] => ids.map((id) => items.find((x) => x.id === id)?.name ?? gone);
  if (filters.projectIds.length > 0) parts.push(listText('project', 'projects', named(filters.projectIds, snapshot.projects, '(deleted)')));
  if (filters.taskIds.length > 0) parts.push(listText('task', 'tasks', named(filters.taskIds, snapshot.tasks, '(deleted)')));
  if (filters.tagIds.length > 0) {
    // "No tag" is a choice beside the tags: "no tag" alone, or last in the list of tags.
    const tagNames = [...named(filters.tagIds.filter((id) => id !== NO_TAG), snapshot.tags, '(deleted)'), ...(filters.tagIds.includes(NO_TAG) ? ['no tag'] : [])];
    parts.push(tagNames.length === 1 && filters.tagIds.includes(NO_TAG) ? 'no tag' : listText('tag', 'tags', tagNames));
  }
  if (filters.band !== null) parts.push(`band ${BANDS[filters.band]} (${HOURS[filters.band]})`);
  if (filters.shiftKey === OUTSIDE) parts.push('outside any shift');
  else if (filters.shiftKey !== null) {
    const versions = groupVersions(snapshot.shifts).get(filters.shiftKey) ?? [];
    const latest = [...versions].sort((a, b) => (a.effectiveFrom < b.effectiveFrom ? 1 : -1))[0];
    parts.push(`shift ${latest?.name ?? '(deleted)'}`);
  }
  const query = filters.query?.trim() ?? '';
  if (query !== '') parts.push(`search "${query}"`);
  return parts.join('; ');
}

/** What the filters of a published view are, in words. */
export const viewFilterText = (snapshot: Snapshot, view: AnalysisView): string => filterText(snapshot, view.shown ?? view.filters);

/** The period of a published view and its filters, for the Export dialog: "9 Mar – 15 Mar 2026, filtered to project Website". */
export function viewScopeText(snapshot: Snapshot, view: AnalysisView, zone: string): string {
  const label = periodOf(view.range, zone).label;
  const filters = viewFilterText(snapshot, view);
  return filters === '' ? label : `${label}, filtered to ${filters}`;
}
