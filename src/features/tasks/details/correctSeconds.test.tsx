// R16: a correction that changes one end of a time entry must not move the other. The date and time inputs hold minutes,
// so an end that was recorded at 14:00:37 came back as 14:00:00 and the entry lost (or gained) the seconds.
import { clearMocks } from '@tauri-apps/api/mocks';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { boot as bootApp, polyfillDom } from '../../../components/testKit';
import { demoState } from '../../../mocks/demoSeed';
import { handle, type MockState } from '../../../mocks/ipcMock';
import type { Snapshot } from '../../../lib/types';

beforeEach(polyfillDom);
afterEach(() => clearMocks());

let state: MockState;
const snap = (): Snapshot => handle(state, 'get_snapshot', {}) as Snapshot;
const corrections = () => state.calls.filter((c) => c.cmd === 'correct_segment').map((c) => (c.args as { input: Record<string, unknown> }).input);

/** Box dieline on Tuesday 10 March, recorded from 14:00:37 to 16:30:12 (UTC, which is Lisbon's time then). */
async function correctBoxDieline() {
  const user = userEvent.setup();
  state = demoState();
  const seg = state.segments.find((x) => x.taskId === 't-box' && x.start === '2026-03-10T14:00:00Z');
  if (!seg) throw new Error('the demo has no such entry');
  seg.start = '2026-03-10T14:00:37Z';
  seg.end = '2026-03-10T16:30:12Z';
  bootApp(state);
  const article = await screen.findByRole('article', { name: 'Box dieline' });
  await user.click(within(article).getByRole('button', { name: 'Details' }));
  const dialog = await screen.findByRole('dialog');
  await user.click(within(dialog).getByRole('tab', { name: 'Corrections' }));
  const rows = within(dialog).getAllByRole('listitem').filter((li) => /Tue 10 Mar 2026.*14:00 to/.test(li.textContent ?? ''));
  const row = rows[rows.length - 1] as HTMLElement;
  await user.click(within(row).getByRole('button', { name: 'Correct' }));
  const form = within(row).getByRole('form', { name: /^Correct / });
  return { user, form };
}

describe('R16: Save correction with one end edited', () => {
  it('sends the start that was not touched with its seconds when only the end was edited', async () => {
    const { user, form } = await correctBoxDieline();
    fireEvent.change(within(form).getByLabelText('New end time'), { target: { value: '16:00' } });
    await user.type(within(form).getByRole('textbox', { name: 'Reason' }), 'Left early');
    await user.click(within(form).getByRole('button', { name: 'Save correction' }));
    await waitFor(() => expect(corrections()).toHaveLength(1));
    expect(corrections()[0]).toMatchObject({ start: '2026-03-10T14:00:37Z', end: '2026-03-10T16:00:00Z' });
    const done = snap().rawSegments.find((s) => s.reason === 'Left early');
    expect(done).toMatchObject({ start: '2026-03-10T14:00:37Z', end: '2026-03-10T16:00:00Z', rawStart: '2026-03-10T14:00:37Z' });
  });

  it('sends the end that was not touched with its seconds when only the start was edited', async () => {
    const { user, form } = await correctBoxDieline();
    fireEvent.change(within(form).getByLabelText('New start time'), { target: { value: '14:10' } });
    await user.type(within(form).getByRole('textbox', { name: 'Reason' }), 'Started late');
    await user.click(within(form).getByRole('button', { name: 'Save correction' }));
    await waitFor(() => expect(corrections()).toHaveLength(1));
    expect(corrections()[0]).toMatchObject({ start: '2026-03-10T14:10:00Z', end: '2026-03-10T16:30:12Z' });
  });

  it('takes both ends as typed, to the minute, when both were edited', async () => {
    const { user, form } = await correctBoxDieline();
    fireEvent.change(within(form).getByLabelText('New start time'), { target: { value: '14:10' } });
    fireEvent.change(within(form).getByLabelText('New end time'), { target: { value: '16:00' } });
    await user.type(within(form).getByRole('textbox', { name: 'Reason' }), 'Both');
    await user.click(within(form).getByRole('button', { name: 'Save correction' }));
    await waitFor(() => expect(corrections()).toHaveLength(1));
    expect(corrections()[0]).toMatchObject({ start: '2026-03-10T14:10:00Z', end: '2026-03-10T16:00:00Z' });
  });
});
