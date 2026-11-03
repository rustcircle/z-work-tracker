// The first-run setup: its steps, which of them the data already answers, and the plain-language rounding table.
// The step number saved by `set_setup_step` is the position in `STEPS`, so the order here is a contract: add to
// the end, never reorder.
import { roundSeconds, type Rule } from '../../lib/billing';
import type { RoundMethod, Snapshot } from '../../lib/types';

export const STEPS = ['welcome', 'connect', 'theme', 'zones', 'rules', 'project', 'shifts', 'sync', 'autostart', 'summary'] as const;
export type StepId = (typeof STEPS)[number];

export const STEP_TITLE: Record<StepId, string> = {
  welcome: 'Welcome',
  connect: 'Connect your other computer',
  theme: 'Theme',
  zones: 'Time zones',
  rules: 'Time rules',
  project: 'Your first project',
  shifts: 'Work shifts',
  sync: 'Sync between computers',
  autostart: 'Start with Windows',
  summary: 'All set',
};

/** Steps the user may leave out. Everything can be skipped; the optional ones are called that on screen. */
/** Steps that create records (projects, shifts) rather than set a preference. */
export const DATA_STEPS: readonly StepId[] = ['project', 'shifts'];

export const OPTIONAL_STEPS: readonly StepId[] = ['project', 'shifts', 'sync'];

/**
 * Whether what is already in the store answers a step. Only replicated data can: it arrives from a sync folder
 * on a second computer. The theme and Start with Windows belong to this device and are always asked.
 */
export function answeredBy(step: StepId, s: Pick<Snapshot, 'settings' | 'rounding' | 'projects' | 'shifts' | 'sync'>): boolean {
  switch (step) {
    case 'zones':
      return typeof s.settings.myZone === 'string' && s.settings.myZone !== '';
    case 'rules':
      return s.rounding.length > 0;
    case 'project':
      return s.projects.length > 0;
    case 'shifts':
      return s.shifts.length > 0;
    // Connecting a folder is the answer to the sync question, and the reason to offer it first.
    case 'sync':
    case 'connect':
      return s.sync.targets.length > 0;
    default:
      return false;
  }
}

export interface VisibleOptions {
  /** A detected folder holds another computer's data, so connecting is offered first. */
  offerConnect: boolean;
  /** First run: skip what the data answers. A rerun from Settings shows every settings step. */
  skipAnswered: boolean;
  /** A rerun changes settings only: the first project and the shifts are data, so they are left out. */
  omitData?: boolean;
}

/** The steps to walk through, in order. */
export function visibleSteps(s: Pick<Snapshot, 'settings' | 'rounding' | 'projects' | 'shifts' | 'sync'>, o: VisibleOptions): StepId[] {
  return STEPS.filter((id) => {
    if (id === 'connect') return o.offerConnect && s.sync.targets.length === 0;
    if (o.omitData && DATA_STEPS.includes(id)) return false;
    if (o.skipAnswered && answeredBy(id, s)) return false;
    return true;
  });
}

/** The step to open at: the saved one, or the nearest visible one after it. */
export function resumeAt(saved: number, steps: readonly StepId[]): StepId {
  const first = steps[0] ?? 'welcome';
  const at = Math.max(0, Math.min(saved, STEPS.length - 1));
  return steps.find((id) => STEPS.indexOf(id) >= at) ?? steps.at(-1) ?? first;
}

export const stepIndex = (id: StepId): number => STEPS.indexOf(id);

// ---- The cloud folder in the Microsoft Store build

/**
 * The one switch for asking firmly for a cloud folder. The Microsoft Store build keeps its files in a private Windows folder that
 * Windows removes when the app is uninstalled, so a OneDrive or Google Drive folder is what keeps the hours. The installer build
 * leaves the question as it was. Two folders are offered in both builds, recommended in the Store build, and required in neither.
 */
export const isPermanentFolderUrged = (packaged: boolean): boolean => packaged;

/** What the build is and how many folders are connected: all that decides whether setup asks firmly for one. */
export interface FolderAsk {
  packaged: boolean;
  folders: number;
}

/** Whether setup asks firmly for a folder right now: in a build that urges one, while none is connected. */
export const folderUrgedNow = (o: FolderAsk): boolean => isPermanentFolderUrged(o.packaged) && o.folders === 0;

/** What the progress line calls a step the person may leave out. The folder step is recommended, not optional, while it is urged. */
export function stepNote(step: StepId, o: FolderAsk): 'optional' | 'recommended' | null {
  if (!OPTIONAL_STEPS.includes(step)) return null;
  return step === 'sync' && folderUrgedNow(o) ? 'recommended' : 'optional';
}

/**
 * Whether setup is about to leave the folder question unanswered while it is urged: the folder step is this one or still ahead.
 * That is Skip on the folder step, and also Finish with defaults from any step before it. Past the step the person has answered
 * it, by connecting or by being asked.
 */
export function folderLeftUnanswered(step: StepId, o: FolderAsk): boolean {
  return folderUrgedNow(o) && stepIndex(step) <= stepIndex('sync');
}

export const FOLDER_URGED = {
  lead: 'Choose a cloud folder.',
  body: 'The Microsoft Store version keeps its files privately, and Windows removes them when the app is uninstalled. A OneDrive or Google Drive folder is what keeps your hours safe. Two folders are better: pick both if you use both.',
} as const;

export const FOLDER_OPTIONAL =
  'Optional. To use zWorkTracker on two computers, it can write its data into a OneDrive or Google Drive folder. Nothing is switched on unless you tick a folder and connect it.';

export const TWO_FOLDERS = 'Connecting both OneDrive and Google Drive keeps a working copy in each.';

/** The question before setup goes on without a folder in a build that urges one. */
export const NO_FOLDER = {
  title: 'Continue without a folder?',
  body: 'If you uninstall the app without one, your hours are gone. You can connect a folder later in Settings.',
  confirm: 'Continue without a folder',
} as const;

// ---- While another computer holds the lease

/** Steps that write data shared between computers. They cannot be changed from here while another computer holds the lease. */
export const SHARED_DATA_STEPS: readonly StepId[] = ['zones', 'rules', 'project', 'shifts'];

export const writesSharedData = (step: StepId): boolean => SHARED_DATA_STEPS.includes(step);

/** What those steps say instead of their controls. */
export const followsHolder = (name: string): string => `These follow ${name}. You can change them after taking over.`;

export interface RuleRow {
  worked: number;
  billed: number;
}

/** What one task's time on one day is billed as, for a few typical amounts. */
export function ruleTable(rule: Rule): RuleRow[] {
  const inc = rule.incrementMinutes;
  const samples = inc === 0 ? [1, 7, 16, 31, 62] : [1, Math.max(2, Math.floor(inc / 2)), inc, inc + 1, inc * 2 + Math.ceil(inc / 3)];
  return [...new Set(samples)].sort((a, b) => a - b).map((m) => ({ worked: m, billed: roundSeconds(m * 60, inc, rule.method) / 60 }));
}

const WORD: Record<RoundMethod, string> = {
  up: 'Every started block counts in full: working one minute is billed as a whole block.',
  nearest: 'Billed to the nearest block: less than half a block rounds down, half or more rounds up.',
  down: 'Only completed blocks count: time inside an unfinished block is not billed.',
};

/** One sentence on what the rule does. */
export function ruleSentence(rule: Rule): string {
  if (rule.incrementMinutes === 0) return 'Rounding is off: Billable time is exactly the time you worked.';
  return `Time is rounded once per task per day, in blocks of ${rule.incrementMinutes} minutes. ${WORD[rule.method]}`;
}
