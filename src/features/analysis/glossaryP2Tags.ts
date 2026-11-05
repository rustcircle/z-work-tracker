// Phase 2 glossary entries: time by tag.
import { g, type GlossaryEntry } from './glossaryBase';

export const GLOSSARY_P2_TAGS: readonly GlossaryEntry[] = [
  g('tags.time', 'Time by tag', 'Tags', 'Follows the Basis switch',
    'The time that counts under the tag: all the time of every task that carries it, except that a subtask with tags of its own counts only under those, and the rest of its task under the task\'s. A task with two tags counts fully in each of them, so tags overlap: the bars and shares of different tags must not be added up, and there is no total across tags. A tag\'s share is its time over the total time of all tasks in the period, so the shares of all tags can add up to more than 100%. Tasks with no tag are listed apart, and deleted tags are not shown. The tag filter keeps the time that counts under any of the selected tags: whole tasks, except that a subtask with tags of its own is kept or left out by those, and Billable rounds the time that is kept; with no tag selected nothing is filtered, and the choice "No tag" keeps the time that counts under none, alone or together with tags.',
    'tag time = sum of the time that counts under the tag; share = tag time / total time of all tasks'),
];
