// The tag filter of the Analysis controls: a checkbox per tag and the choice "No tag", with the sentence under them that
// says what is kept. None chosen is the same as all.
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { Controls } from './Controls';
import { NO_FILTERS, type Filters } from './engine';
import { NO_TAG } from './tagFilter';
import { mkSnapshot } from './testkit';

const SNAPSHOT = mkSnapshot({
  now: '2026-03-12T12:00:00Z',
  projects: [{ id: 'p' }],
  tasks: [{ id: 't', projectId: 'p' }],
  tags: [
    { id: 'a', name: 'Design', color: '#7c3aed' },
    { id: 'b', name: 'Client', color: '#0f766e' },
    { id: 'gone', name: 'Old', deleted: true },
  ],
});

function Harness({ start = NO_FILTERS, seen }: { start?: Filters; seen?: (f: Filters) => void }) {
  const [filters, setFilters] = useState<Filters>(start);
  return (
    <Controls
      snapshot={SNAPSHOT}
      today="2026-03-12"
      range={{ kind: 'week', anchor: '2026-03-12' }}
      setRange={vi.fn()}
      periodLabel="9 Mar – 15 Mar 2026"
      filters={filters}
      setFilters={(f) => {
        setFilters(f);
        seen?.(f);
      }}
      basis="billable"
      setBasis={vi.fn()}
      billableAvailable
      compare={false}
      setCompare={vi.fn()}
      onGlossary={vi.fn()}
    />
  );
}

const group = (): HTMLElement => screen.getByRole('group', { name: 'Tag filter' });
const hint = (): string => group().querySelector('.a-tag-hint')?.textContent ?? '';

describe('the tag filter', () => {
  it('has a checkbox for each tag that exists and one for "No tag", last', () => {
    render(<Harness />);
    expect(within(group()).getAllByRole('checkbox').map((c) => c.closest('label')?.textContent)).toEqual(['Design', 'Client', 'No tag']);
  });

  it('says that every task is kept while nothing is chosen', () => {
    render(<Harness />);
    expect(hint()).toBe('All tasks; whole tasks are kept, so Billable stays available.');
  });

  it('chooses and un-chooses "No tag" like a tag, in the filters the figures use', async () => {
    const user = userEvent.setup();
    const seen = vi.fn();
    render(<Harness seen={seen} />);
    await user.click(within(group()).getByRole('checkbox', { name: 'No tag' }));
    expect(seen).toHaveBeenLastCalledWith({ ...NO_FILTERS, tagIds: [NO_TAG] });
    expect(within(group()).getByRole('checkbox', { name: 'No tag' })).toBeChecked();
    expect(hint()).toBe('Tasks with no tag; whole tasks are kept, so Billable stays available.');
    await user.click(within(group()).getByRole('checkbox', { name: 'No tag' }));
    expect(seen).toHaveBeenLastCalledWith({ ...NO_FILTERS, tagIds: [] });
    expect(hint()).toBe('All tasks; whole tasks are kept, so Billable stays available.');
  });

  it('says that a tag keeps the tasks with any selected tag, and "No tag" with a tag keeps the untagged ones as well', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.click(within(group()).getByRole('checkbox', { name: 'Design' }));
    expect(hint()).toBe('Tasks with any selected tag; whole tasks are kept, so Billable stays available.');
    await user.click(within(group()).getByRole('checkbox', { name: 'Client' }));
    expect(hint()).toBe('Tasks with any selected tag; whole tasks are kept, so Billable stays available.');
    await user.click(within(group()).getByRole('checkbox', { name: 'No tag' }));
    expect(hint()).toBe('Tasks with any selected tag, or with no tag; whole tasks are kept, so Billable stays available.');
  });

  it('is cleared with the other filters by "Clear filters", and offers that button while "No tag" is chosen', async () => {
    const user = userEvent.setup();
    const seen = vi.fn();
    render(<Harness start={{ ...NO_FILTERS, tagIds: [NO_TAG] }} seen={seen} />);
    await user.click(screen.getByRole('button', { name: 'Clear filters' }));
    expect(seen).toHaveBeenLastCalledWith(NO_FILTERS);
    expect(within(group()).getByRole('checkbox', { name: 'No tag' })).not.toBeChecked();
    expect(screen.queryByRole('button', { name: 'Clear filters' })).toBeNull();
  });

  it('is not offered when there are no tags to choose between', () => {
    render(<Controls snapshot={{ ...SNAPSHOT, tags: [] }} today="2026-03-12" range={{ kind: 'week', anchor: '2026-03-12' }} setRange={vi.fn()} periodLabel="x" filters={NO_FILTERS} setFilters={vi.fn()} basis="billable" setBasis={vi.fn()} billableAvailable compare={false} setCompare={vi.fn()} onGlossary={vi.fn()} />);
    expect(screen.queryByRole('group', { name: 'Tag filter' })).toBeNull();
  });
});
