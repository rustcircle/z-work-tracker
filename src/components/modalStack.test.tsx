// Dialogs can be open over one another. Esc and Tab belong to the one on top, and to nothing under it.
import { emit } from '@tauri-apps/api/event';
import { clearMocks } from '@tauri-apps/api/mocks';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { demoState } from '../mocks/demoSeed';
import { DEVICE_ID } from '../mocks/ipcMock';
import { boot, polyfillDom } from './testKit';
import { Button, Modal } from './ui';

beforeEach(() => {
  polyfillDom();
  // jsdom has no layout, so every element reports no offset parent and the focus trap would see nothing it can reach.
  vi.spyOn(HTMLElement.prototype, 'offsetParent', 'get').mockImplementation(function (this: HTMLElement) {
    return this.parentElement;
  });
});
afterEach(() => {
  clearMocks();
  vi.restoreAllMocks();
});

const esc = (): boolean => fireEvent.keyDown(document.body, { key: 'Escape' });

describe('Esc with dialogs open over one another', () => {
  it('R3: one Esc closes the dialog on top only, and the next one closes the dialog under it', () => {
    const under = vi.fn();
    const over = vi.fn();
    const tree = (overOpen: boolean) => (
      <>
        <Modal open title="Under" onClose={under}>
          <p>under</p>
        </Modal>
        <Modal open={overOpen} title="Over" onClose={over}>
          <p>over</p>
        </Modal>
      </>
    );
    const { rerender } = render(tree(true));
    esc();
    expect(over).toHaveBeenCalledTimes(1);
    expect(under).not.toHaveBeenCalled();
    rerender(tree(false));
    esc();
    expect(under).toHaveBeenCalledTimes(1);
    expect(over).toHaveBeenCalledTimes(1);
  });

  it('R3: the dialog opened last is the one on top, wherever it comes in the page', () => {
    const first = vi.fn();
    const second = vi.fn();
    const tree = (firstOpen: boolean) => (
      <>
        <Modal open={firstOpen} title="First in the page" onClose={first}>
          <p>a</p>
        </Modal>
        <Modal open title="Second in the page" onClose={second}>
          <p>b</p>
        </Modal>
      </>
    );
    const { rerender } = render(tree(false));
    rerender(tree(true));
    esc();
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).not.toHaveBeenCalled();
  });

  it('R3: a dialog on top that cannot be dismissed keeps Esc from the dialog under it', () => {
    const under = vi.fn();
    const over = vi.fn();
    render(
      <>
        <Modal open title="Under" onClose={under}>
          <p>under</p>
        </Modal>
        <Modal open title="Over" onClose={over} dismissible={false}>
          <p>over</p>
        </Modal>
      </>,
    );
    esc();
    expect(under).not.toHaveBeenCalled();
    expect(over).not.toHaveBeenCalled();
  });

  it('R3: a dialog that was closed and opened again goes on top of the one that opened in between', () => {
    const a = vi.fn();
    const b = vi.fn();
    const tree = (aOpen: boolean, bOpen: boolean) => (
      <>
        <Modal open={aOpen} title="A" onClose={a}>
          <p>a</p>
        </Modal>
        <Modal open={bOpen} title="B" onClose={b}>
          <p>b</p>
        </Modal>
      </>
    );
    const { rerender } = render(tree(true, true));
    rerender(tree(false, true));
    rerender(tree(true, true));
    esc();
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).not.toHaveBeenCalled();
  });

  it('R3: a dialog that is switched between dismissible and not stays where it is in the stack', () => {
    const a = vi.fn();
    const b = vi.fn();
    const tree = (aDismissible: boolean) => (
      <>
        <Modal open title="A" onClose={a} dismissible={aDismissible}>
          <p>a</p>
        </Modal>
        <Modal open title="B" onClose={b}>
          <p>b</p>
        </Modal>
      </>
    );
    const { rerender } = render(tree(true));
    rerender(tree(false));
    rerender(tree(true));
    esc();
    expect(b).toHaveBeenCalledTimes(1);
    expect(a).not.toHaveBeenCalled();
  });
});

describe('focus with dialogs open over one another', () => {
  it('R3: a dialog that closes while another is open over it leaves focus in the one on top', () => {
    const tree = (underOpen: boolean, overOpen: boolean) => (
      <>
        <button type="button">page button</button>
        <Modal open={underOpen} title="Under" onClose={() => undefined}>
          <Button data-autofocus>under one</Button>
        </Modal>
        <Modal open={overOpen} title="Over" onClose={() => undefined}>
          <Button data-autofocus>over one</Button>
        </Modal>
      </>
    );
    const { rerender } = render(tree(false, false));
    screen.getByRole('button', { name: 'page button' }).focus();
    rerender(tree(true, false));
    rerender(tree(true, true));
    const over = screen.getByRole('dialog', { name: 'Over' });
    expect(over).toContainElement(document.activeElement as HTMLElement);
    rerender(tree(false, true));
    expect(over).toContainElement(document.activeElement as HTMLElement);
    // And once the one on top closes, focus goes back to where it was before any of them opened.
    rerender(tree(false, false));
    expect(screen.getByRole('button', { name: 'page button' })).toHaveFocus();
  });

  it('R3: closing the dialog on top returns focus to the dialog under it, and closing that returns it to the page', () => {
    const tree = (overOpen: boolean, underOpen: boolean) => (
      <>
        <button type="button">page button</button>
        <Modal open={underOpen} title="Under" onClose={() => undefined}>
          <Button data-autofocus>under one</Button>
        </Modal>
        <Modal open={overOpen} title="Over" onClose={() => undefined}>
          <Button data-autofocus>over one</Button>
        </Modal>
      </>
    );
    const { rerender } = render(tree(false, false));
    screen.getByRole('button', { name: 'page button' }).focus();
    rerender(tree(false, true));
    expect(screen.getByRole('button', { name: 'under one' })).toHaveFocus();
    rerender(tree(true, true));
    expect(screen.getByRole('button', { name: 'over one' })).toHaveFocus();
    rerender(tree(false, true));
    expect(screen.getByRole('button', { name: 'under one' })).toHaveFocus();
    rerender(tree(false, false));
    expect(screen.getByRole('button', { name: 'page button' })).toHaveFocus();
  });
});

describe('Tab with dialogs open over one another', () => {
  it('R3: focus that is on a dialog under the one on top is not wrapped inside the dialog under', async () => {
    const user = userEvent.setup();
    render(
      <>
        <Modal open title="Under" onClose={() => undefined}>
          <Button>under one</Button>
          <Button>under two</Button>
        </Modal>
        <Modal open title="Over" onClose={() => undefined}>
          <Button>over one</Button>
          <Button>over two</Button>
        </Modal>
      </>,
    );
    const over = screen.getByRole('dialog', { name: 'Over' });
    expect(over).toContainElement(document.activeElement as HTMLElement);
    // Focus is left on the last button of the dialog under, as when the dialog on top opened by itself.
    screen.getByRole('button', { name: 'under two' }).focus();
    await user.tab();
    // The dialog under must not take the key to wrap focus round to its own first button.
    expect(screen.getByRole('button', { name: 'under one' })).not.toHaveFocus();
    expect(over).toContainElement(document.activeElement as HTMLElement);
  });

  it('R3: the dialog on top still keeps Tab inside itself, both ways', async () => {
    const user = userEvent.setup();
    render(
      <>
        <Modal open title="Under" onClose={() => undefined}>
          <Button>under one</Button>
        </Modal>
        <Modal open title="Over" onClose={() => undefined}>
          <Button>over one</Button>
          <Button>over two</Button>
        </Modal>
      </>,
    );
    const over = within(screen.getByRole('dialog', { name: 'Over' }));
    const buttons = over.getAllByRole('button');
    const last = buttons[buttons.length - 1] as HTMLElement;
    last.focus();
    await user.tab();
    expect(buttons[0]).toHaveFocus();
    await user.tab({ shift: true });
    expect(last).toHaveFocus();
  });
});

describe('the time-away dialog opening over Details', () => {
  it('R3: Esc closes the dialog that opened and leaves Details and the reason typed in it', async () => {
    const user = userEvent.setup();
    const s = demoState();
    boot(s);
    const card = await screen.findByRole('article', { name: 'Brand guidelines' });
    await user.click(within(card).getByRole('button', { name: 'Details' }));
    const details = await screen.findByRole('dialog', { name: /Details: Brand guidelines/ });
    await user.type(within(details).getByRole('textbox', { name: 'Reason' }), 'typed reason');
    const seg = s.segments.find((x) => x.taskId === 't-logo' && x.end === null);
    if (!seg) throw new Error('the demo has no running segment for t-logo');
    s.gaps.push({ id: 'g1', segmentId: seg.id, taskId: 't-logo', deviceId: DEVICE_ID, start: '2026-03-12T14:00:00Z', end: '2026-03-12T14:30:00Z', kind: 'sleep', decision: 'pending', decisionStamp: { at: '2026-03-12T14:30:00Z', by: DEVICE_ID } });
    await act(async () => {
      await emit('state-changed');
    });
    await screen.findByRole('dialog', { name: /You were away/ });
    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog', { name: /You were away/ })).toBeNull());
    const still = screen.getByRole('dialog', { name: /Details: Brand guidelines/ });
    expect(within(still).getByRole('textbox', { name: 'Reason' })).toHaveValue('typed reason');
  });
});
