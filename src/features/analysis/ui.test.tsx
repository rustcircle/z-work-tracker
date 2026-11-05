// The glossary is a dialog and the drill-down is a panel beside the page. Both leave the keyboard where they found it.
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DrillPanel, GlossaryDialog, type DrillContext } from './ui';

beforeEach(() => {
  // jsdom has no layout, so every element reports no offset parent and the focus trap would see nothing it can reach.
  vi.spyOn(HTMLElement.prototype, 'offsetParent', 'get').mockImplementation(function (this: HTMLElement) {
    return this.parentElement;
  });
});
afterEach(() => vi.restoreAllMocks());

const CTX: DrillContext = { spans: [], zone: 'UTC', clientZone: null, nowSec: 0, projects: new Map(), tasks: new Map(), tags: new Map() };

function Page() {
  const [glossary, setGlossary] = useState(false);
  const [drill, setDrill] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setGlossary(true)}>
        Metrics glossary
      </button>
      <button type="button" onClick={() => setDrill(true)}>
        Open drill-down
      </button>
      {/* A chart mark is an SVG element with a tab stop, not a button. */}
      <svg width="20" height="20" aria-hidden="false">
        <g role="button" tabIndex={0} aria-label="Mark Mon 9" onClick={() => setDrill(true)} />
      </svg>
      <button type="button">Elsewhere on the page</button>
      <GlossaryDialog open={glossary} focusId={null} onClose={() => setGlossary(false)} />
      {drill ? <DrillPanel sel={{ title: 'Mon 9 Mar', day: 20521 }} ctx={CTX} onClose={() => setDrill(false)} /> : null}
    </>
  );
}

const glossary = () => screen.getByRole('dialog', { name: 'Metrics glossary' });
const drill = () => screen.queryByRole('dialog', { name: 'Drill-down: Mon 9 Mar' });

describe('the glossary dialog', () => {
  it('R13: Tab and Shift+Tab go round inside it and never out to the page', async () => {
    const user = userEvent.setup();
    render(<Page />);
    await user.click(screen.getByRole('button', { name: 'Metrics glossary' }));
    const dialog = glossary();
    // The search box has the cursor, as it always had.
    expect(within(dialog).getByRole('searchbox', { name: 'Search metrics' })).toHaveFocus();
    for (let i = 0; i < 6; i += 1) {
      await user.tab();
      expect(dialog).toContainElement(document.activeElement as HTMLElement);
    }
    for (let i = 0; i < 6; i += 1) {
      await user.tab({ shift: true });
      expect(dialog).toContainElement(document.activeElement as HTMLElement);
    }
  });

  it('R13: Esc closes it and focus goes back to the button that opened it', async () => {
    const user = userEvent.setup();
    render(<Page />);
    await user.click(screen.getByRole('button', { name: 'Metrics glossary' }));
    glossary();
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog', { name: 'Metrics glossary' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Metrics glossary' })).toHaveFocus();
  });

  it('R13: its Close button closes it and focus goes back there too', async () => {
    const user = userEvent.setup();
    render(<Page />);
    await user.click(screen.getByRole('button', { name: 'Metrics glossary' }));
    await user.click(within(glossary()).getByRole('button', { name: /^Close/ }));
    expect(screen.queryByRole('dialog', { name: 'Metrics glossary' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Metrics glossary' })).toHaveFocus();
  });

  it('R13: one Esc closes it and leaves the drill-down panel open, the next closes the panel', async () => {
    const user = userEvent.setup();
    render(<Page />);
    await user.click(screen.getByRole('button', { name: 'Open drill-down' }));
    expect(drill()).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Metrics glossary' }));
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog', { name: 'Metrics glossary' })).toBeNull();
    expect(drill()).toBeVisible();
    await user.keyboard('{Escape}');
    expect(drill()).toBeNull();
  });

  it('R13: searching still narrows the list, and says so when nothing matches', async () => {
    const user = userEvent.setup();
    render(<Page />);
    await user.click(screen.getByRole('button', { name: 'Metrics glossary' }));
    const dialog = within(glossary());
    await user.type(dialog.getByRole('searchbox', { name: 'Search metrics' }), 'qqqqqq');
    expect(dialog.getByText(/No metric matches/)).toBeVisible();
    expect(dialog.getByRole('status')).toHaveTextContent(/^0 of \d+ metrics$/);
  });
});

describe('the drill-down panel', () => {
  it('R13: it stays a panel beside the page: the page behind it can still be reached with Tab', async () => {
    const user = userEvent.setup();
    render(<Page />);
    await user.click(screen.getByRole('button', { name: 'Open drill-down' }));
    const panel = drill() as HTMLElement;
    expect(panel).not.toHaveAttribute('aria-modal');
    // Tab walks on out of the panel to the rest of the page.
    let leftIt = false;
    for (let i = 0; i < 6; i += 1) {
      await user.tab();
      if (!panel.contains(document.activeElement)) leftIt = true;
    }
    expect(leftIt).toBe(true);
  });

  it('R13: Esc closes it and focus goes back to the control that opened it', async () => {
    const user = userEvent.setup();
    render(<Page />);
    await user.click(screen.getByRole('button', { name: 'Open drill-down' }));
    expect(drill()).toHaveFocus();
    await user.keyboard('{Escape}');
    expect(drill()).toBeNull();
    expect(screen.getByRole('button', { name: 'Open drill-down' })).toHaveFocus();
  });

  it('R13: Esc gives focus back to a chart mark too, which is an SVG element', async () => {
    const user = userEvent.setup();
    render(<Page />);
    const mark = screen.getByRole('button', { name: 'Mark Mon 9' });
    await user.click(mark);
    expect(drill()).toHaveFocus();
    await user.keyboard('{Escape}');
    expect(drill()).toBeNull();
    expect(mark).toHaveFocus();
  });

  it('R13: it lies under the dialogs, so the glossary opened over it is not covered by it', async () => {
    const user = userEvent.setup();
    render(<Page />);
    await user.click(screen.getByRole('button', { name: 'Open drill-down' }));
    // Dialogs are drawn at layer 50 (styles/ui.css) and the panel used to be at 90.
    const layer = (drill() as HTMLElement).style.zIndex;
    expect(layer).not.toBe('');
    expect(Number(layer)).toBeLessThan(50);
  });
});
