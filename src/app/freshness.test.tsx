// A screen left open must end up saying what the same screen says when opened afresh on the same data. Changes reach
// a screen two ways, a reply it adopts and the backend's `state-changed` (tray, sync from another device, time away),
// and both end in one new snapshot, so these tests use the second: nothing here acts through the screen under test.
import { emit } from '@tauri-apps/api/event';
import { clearMocks } from '@tauri-apps/api/mocks';
import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { boot, polyfillDom } from '../components/testKit';
import { entryOf } from '../features/timeline/selectionLogic';
import { demoState } from '../mocks/demoSeed';
import { handle, type MockState } from '../mocks/ipcMock';
import type { Snapshot } from '../lib/types';

beforeEach(polyfillDom);
afterEach(() => {
  cleanup();
  clearMocks();
  vi.restoreAllMocks();
});

const settle = async (): Promise<void> => {
  for (let i = 0; i < 6; i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 10));
    });
  }
};

/** The backend changed something on its own and says so. */
async function arrives(s: MockState, change: (s: MockState) => void): Promise<void> {
  change(s);
  await act(async () => {
    await emit('state-changed');
  });
  await settle();
}

async function open(s: MockState, tab: string) {
  const user = userEvent.setup();
  boot(s);
  await user.click(await screen.findByRole('tab', { name: tab }));
  await settle();
  return user;
}

const project = (s: MockState, id: string) => s.projects.find((p) => p.id === id)!;
const projectInput = (s: MockState, id: string, over: Record<string, unknown>) => {
  const p = project(s, id);
  return { name: p.name, color: p.color, billable: p.billable, budgetHours: p.budgetHours, clientZone: p.clientZone, billingType: 'hourly', ...over };
};

/** Everything a person reads or has entered on the page, in order. */
function pageLines(root: Element): string[] {
  const out: string[] = [];
  const walk = (n: Node): void => {
    if (n.nodeType === Node.TEXT_NODE) {
      const t = (n.textContent ?? '').trim();
      if (t) out.push(t);
      return;
    }
    if (!(n instanceof Element)) return;
    if (n.tagName.toLowerCase() === 'svg') {
      out.push(`chart:${n.getAttribute('aria-label') ?? ''}`);
      return;
    }
    if (n instanceof HTMLInputElement) out.push(`input=${n.type === 'checkbox' || n.type === 'radio' ? String(n.checked) : n.value}`);
    if (n instanceof HTMLSelectElement) out.push(`select=${n.value}`);
    n.childNodes.forEach(walk);
  };
  walk(root);
  return out;
}

/** One of every kind of change, none of them through a screen. */
function changeEverything(s: MockState): void {
  handle(s, 'create_summary', { request: { projectId: 'p-web', from: '2026-01-01', to: '2026-03-12', zone: 'Europe/Lisbon' } });
  handle(s, 'update_project', { id: 'p-brand', input: projectInput(s, 'p-brand', { name: 'Renamed project', color: '#123456', budgetHours: 300 }) });
  handle(s, 'set_project_archived', { id: 'p-pack', archived: true });
  handle(s, 'set_rate', { input: { projectId: 'p-brand', rateCents: 99900, currency: 'USD', effectiveFrom: '2026-01-01T00:00:00Z', confirmRetroactive: true } });
  handle(s, 'set_rounding', { input: { projectId: null, effectiveFrom: '2026-01-01', incrementMinutes: 30, method: 'up', confirmRetroactive: true }, today: '2026-03-12' });
  handle(s, 'patch_task', { id: 't-home', patch: { name: 'Renamed task', projectId: 'p-brand', tags: ['tag-revision'] } });
  handle(s, 'save_tag', { input: { id: 'tag-revision', name: 'Renamed tag', color: '#0f766e' } });
  handle(s, 'save_template', { input: { id: null, name: 'New template', projectId: 'p-brand', description: null, tags: [] } });
  handle(s, 'add_manual_entry', { input: { taskId: 't-home', start: '2026-03-12T05:00:00Z', end: '2026-03-12T06:00:00Z', reason: 'by hand', allowOverlap: true } });
  handle(s, 'correct_segment', { input: { segmentId: 's1', start: '2026-02-23T08:00:00Z', end: '2026-02-23T11:20:00Z', reason: 'moved', allowOverlap: true } });
  handle(s, 'void_segment', { id: 's2', reason: 'gone' });
  handle(s, 'stop_task', { id: 't-logo' });
  handle(s, 'set_hide_earnings', { hide: true });
  handle(s, 'set_setting', { key: 'activeZone', value: 'Asia/Tokyo' });
  handle(s, 'set_setting', { key: 'dailyTargetHours', value: 2 });
  handle(s, 'set_setting', { key: 'weeklyTargetHours', value: 11 });
  handle(s, 'set_setting', { key: 'idleMinutes', value: 77 });
  handle(s, 'set_setting', { key: 'clientWorkStart', value: '07:30' });
  handle(s, 'save_shift', { input: { shiftId: null, effectiveFrom: '2026-01-01', name: 'New shift', color: '#ff0000', start: '20:00', end: '23:00', weekdays: [1, 2], zone: 'Europe/Lisbon' } });
  handle(s, 'set_backup_keep', { keep: 3 });
  handle(s, 'set_device_prefix', { prefix: 'ZZZ' });
  handle(s, 'delete_task', { id: 't-box' });
}

describe('a screen left open reads the same as one opened afresh', () => {
  it.each(['Timeline', 'Analysis', 'Billing', 'Projects', 'Settings'])('%s', { timeout: 30_000 }, async (tab) => {
    const s = demoState();
    await open(s, tab);
    await arrives(s, changeEverything);
    const held = pageLines(document.body);
    cleanup();
    clearMocks();
    await open(s, tab);
    const fresh = pageLines(document.body);
    expect(held).toEqual(fresh);
  });
});

describe('History of changes in Settings', () => {
  it('shows a change as it is recorded', async () => {
    const s = demoState();
    await open(s, 'Settings');
    expect(screen.getByText(/Nothing has been recorded yet/)).toBeInTheDocument();
    await arrives(s, (x) => handle(x, 'void_segment', { id: 's1', reason: 'entered twice' }));
    expect(screen.queryByText(/Nothing has been recorded yet/)).toBeNull();
    expect(document.body).toHaveTextContent('entered twice');
  });
});

describe('Backups in Settings', () => {
  it('lists a backup taken while the page is open', async () => {
    const s = demoState();
    await open(s, 'Settings');
    await arrives(s, (x) => x.backups.push({ name: 'zwork-2026-03-12.json', bytes: 2048, safety: false }));
    expect(screen.getByText(/zwork-2026-03-12\.json/)).toBeInTheDocument();
  });
});

describe('Targets in Settings', () => {
  const fields = () => ({ daily: screen.getByLabelText('Daily target (hours)'), weekly: screen.getByLabelText('Weekly target (hours)') });

  it('shows targets that arrive from elsewhere', async () => {
    const s = demoState();
    await open(s, 'Settings');
    await arrives(s, (x) => handle(x, 'set_setting', { key: 'dailyTargetHours', value: 2 }));
    expect(fields().daily).toHaveValue('2');
  });

  it('leaves alone what is being typed, and the other field follows', async () => {
    const s = demoState();
    const user = await open(s, 'Settings');
    await user.clear(fields().daily);
    await user.type(fields().daily, '4.5');
    await arrives(s, (x) => {
      handle(x, 'set_setting', { key: 'dailyTargetHours', value: 2 });
      handle(x, 'set_setting', { key: 'weeklyTargetHours', value: 11 });
    });
    expect(fields().daily).toHaveValue('4.5');
    expect(fields().weekly).toHaveValue('11');
  });

  it('goes back to following once saved', async () => {
    const s = demoState();
    const user = await open(s, 'Settings');
    await user.clear(fields().daily);
    await user.type(fields().daily, '4.5');
    await user.click(screen.getByRole('button', { name: 'Save targets' }));
    await waitFor(() => expect(s.settings.dailyTargetHours).toBe(4.5));
    await settle();
    await arrives(s, (x) => handle(x, 'set_setting', { key: 'dailyTargetHours', value: 2 }));
    expect(fields().daily).toHaveValue('2');
  });
});

describe('Rounding in Settings', () => {
  const section = () => screen.getByRole('heading', { name: 'Rounding' }).closest('section') ?? document.body;
  const round = { projectId: null, effectiveFrom: '2026-01-01', method: 'up', confirmRetroactive: true };

  it('offers the rule now in force, not the one when the page opened', async () => {
    const s = demoState();
    await open(s, 'Settings');
    await arrives(s, (x) => handle(x, 'set_rounding', { input: { ...round, incrementMinutes: 30 }, today: '2026-03-12' }));
    expect(screen.getByTestId('current-rounding')).toHaveTextContent('30');
    expect(within(section()).getAllByRole('combobox')[0]).toHaveValue('30');
  });

  it('starts from today, also after today has moved with the zone', async () => {
    const s = demoState();
    await open(s, 'Settings');
    await arrives(s, (x) => handle(x, 'set_setting', { key: 'activeZone', value: 'Asia/Tokyo' }));
    expect(screen.queryByText(/This date is in the past/)).toBeNull();
  });
});

describe('Budget burn-up in Analysis', () => {
  const picker = () => screen.getByRole('heading', { name: 'Budget burn-up' }).closest('article')!.querySelector('select')!;

  it('follows the budget list until a project is chosen', async () => {
    const s = demoState();
    await open(s, 'Analysis');
    expect(picker()).toHaveValue('p-web');
    await arrives(s, (x) => handle(x, 'update_project', { id: 'p-brand', input: projectInput(x, 'p-brand', { budgetHours: 3 }) }));
    expect(picker()).toHaveValue('p-brand');
  });

  it('keeps a project that was chosen', async () => {
    const s = demoState();
    handle(s, 'update_project', { id: 'p-brand', input: projectInput(s, 'p-brand', { budgetHours: 3 }) });
    const user = await open(s, 'Analysis');
    await user.selectOptions(picker(), 'p-web');
    await arrives(s, (x) => handle(x, 'patch_task', { id: 't-home', patch: { name: 'Renamed' } }));
    expect(picker()).toHaveValue('p-web');
  });
});

describe('the budget of a project with a running task', () => {
  it('moves with the time, with no new snapshot', async () => {
    const s = demoState();
    handle(s, 'update_project', { id: 'p-brand', input: projectInput(s, 'p-brand', { budgetHours: 100 }) });
    const at = Date.now();
    await open(s, 'Projects');
    const row = () => screen.getByRole('heading', { name: 'Brand refresh' }).closest('li')!;
    const before = parseInt(within(row()).getByTestId('budget').querySelector('.budget-percent')!.textContent ?? '', 10);
    const asked = s.calls.filter((c) => c.cmd === 'get_snapshot').length;

    vi.spyOn(Date, 'now').mockImplementation(() => at + 20 * 3600_000);
    fireEvent.focus(window);
    await settle();

    const after = parseInt(within(row()).getByTestId('budget').querySelector('.budget-percent')!.textContent ?? '', 10);
    expect(after).toBeGreaterThanOrEqual(before + 19);
    expect(s.calls.filter((c) => c.cmd === 'get_snapshot').length).toBe(asked);
  });
});

describe('the selected entries', () => {
  it('lose an entry whose time goes while another tab is open', async () => {
    const s = demoState();
    const user = await open(s, 'Timeline');
    const row = [...document.querySelectorAll<HTMLElement>('tr[data-row-id]')].find((r) => !entryOf(r.dataset.selKey ?? '').taskId.includes('logo'))!;
    await user.click(row);
    expect(screen.getByRole('button', { name: 'Export (1 selected)' })).toBeInTheDocument();
    const { taskId } = entryOf(row.dataset.selKey ?? '');
    await user.click(screen.getByRole('tab', { name: 'Projects' }));
    await settle();
    await arrives(s, (x) => {
      const snap = handle(x, 'get_snapshot', {}) as Snapshot;
      for (const seg of snap.rawSegments.filter((g) => g.taskId === taskId && !g.voided && g.end !== null)) handle(x, 'void_segment', { id: seg.id, reason: 'gone' });
    });
    expect(screen.queryByRole('button', { name: /selected/ })).toBeNull();
  });
});

describe('a filter on something that goes', () => {
  it('in the task list: a deleted tag no longer hides every task', async () => {
    const s = demoState();
    handle(s, 'patch_task', { id: 't-home', patch: { tags: ['tag-revision'] } });
    const user = userEvent.setup();
    boot(s);
    await screen.findByRole('article', { name: 'Homepage layout' });
    await settle();
    await user.click(screen.getByRole('checkbox', { name: 'Filter tasks by tag Revision' }));
    await settle();
    expect(screen.queryByRole('article', { name: 'Box dieline' })).toBeNull();
    await arrives(s, (x) => handle(x, 'delete_tag', { id: 'tag-revision' }));
    expect(screen.getByRole('article', { name: 'Box dieline' })).toBeInTheDocument();
  });
});

describe('the period on screen', () => {
  // Sunday evening in Lisbon, the last of the month, is already Monday the 1st in Tokyo. Lisbon is an hour ahead of UTC.
  const sundayNight = () => {
    const s = demoState();
    handle(s, 'stop_task', { id: 't-logo' });
    s.now = Date.parse('2026-05-31T20:00:00Z') / 1000;
    return s;
  };

  it.each([['Analysis'], ['Billing']])('%s moves to the new period with the zone until one is chosen', { timeout: 15_000 }, async (tab) => {
    const s = sundayNight();
    await open(s, tab);
    await arrives(s, (x) => handle(x, 'set_setting', { key: 'activeZone', value: 'Asia/Tokyo' }));
    const held = pageLines(document.body);
    cleanup();
    clearMocks();
    await open(s, tab);
    expect(held).toEqual(pageLines(document.body));
  });

  it('Analysis keeps a period that was chosen', { timeout: 15_000 }, async () => {
    const s = sundayNight();
    const user = await open(s, 'Analysis');
    await user.click(screen.getByRole('radio', { name: 'Year' }));
    await settle();
    const label = () => document.querySelector('.a-controls')?.textContent ?? '';
    const chosen = label();
    await arrives(s, (x) => handle(x, 'set_setting', { key: 'activeZone', value: 'Asia/Tokyo' }));
    expect(label()).toBe(chosen);
  });

  it('the PDF export starts on the period around today, not the one of the launch', { timeout: 15_000 }, async () => {
    const s = demoState();
    handle(s, 'stop_task', { id: 't-logo' });
    const user = await open(s, 'Timeline');
    const at = Date.now();
    vi.spyOn(Date, 'now').mockImplementation(() => at + 60 * 86_400_000);
    fireEvent.focus(window);
    await settle();
    await user.click(screen.getByRole('button', { name: /^Export/ }));
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('radio', { name: /PDF/ }));
    expect(within(dialog).getByText(/May 2026/)).toBeInTheDocument();
  });
});

describe('a filter in Analysis on something that goes', () => {
  it('a deleted tag no longer hides all the time', { timeout: 15_000 }, async () => {
    const s = demoState();
    handle(s, 'patch_task', { id: 't-home', patch: { tags: ['tag-revision'] } });
    const user = await open(s, 'Analysis');
    const panel = screen.getByRole('tabpanel');
    await user.click(within(panel).getByRole('checkbox', { name: /Revision/ }));
    await settle();
    await arrives(s, (x) => handle(x, 'delete_tag', { id: 'tag-revision' }));
    expect(panel.querySelector('.a-tag-hint')).toHaveTextContent('All tasks');
    expect(within(panel).queryByText('No logged time here')).toBeNull();
  });
});

describe('the task editor', () => {
  it.each(['project', 'tags'])('saves a choice of %s at once, without waiting for more typing', async (field) => {
    const s = demoState();
    const user = userEvent.setup();
    boot(s);
    const card = await screen.findByRole('article', { name: 'Homepage layout' });
    await settle();
    await user.click(within(card).getByRole('button', { name: 'Edit Homepage layout' }));
    await settle();
    const saves = () => s.calls.filter((c) => c.cmd === 'patch_task');
    expect(saves()).toHaveLength(0);
    if (field === 'project') await user.selectOptions(within(card).getByLabelText('Project'), 'p-brand');
    else await user.click(within(card).getByRole('checkbox', { name: /Revision/ }));
    // Well inside the 600 ms that text waits for.
    await waitFor(() => expect(saves()).toHaveLength(1), { timeout: 250 });
  });
});
