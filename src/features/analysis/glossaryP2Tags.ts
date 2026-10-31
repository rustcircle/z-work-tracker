// Phase 2 glossary entries: time by tag.
import { g, type GlossaryEntry } from './glossaryBase';

export const GLOSSARY_P2_TAGS: readonly GlossaryEntry[] = [
  g('tags.time', 'Time by tag', 'Tags', 'Follows the Basis switch',
    'The time of every task that carries the tag. A task with two tags counts fully in each of them, so tags overlap: the bars and shares of different tags must not be added up, and there is no total across tags. A tag\'s share is its time over the total time of all tasks in the period, so the shares of all tags can add up to more than 100%. Tasks with no tag are listed apart, and deleted tags are not shown. The tag filter keeps the tasks that carry any of the selected tags, as whole tasks, so Billable stays available.',
    'tag time = sum of the time of the tasks carrying the tag; share = tag time / total time of all tasks'),
];
