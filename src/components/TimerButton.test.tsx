// A timer button never reacts to Space. The app is worked with the mouse, so a Space that lands on a button an earlier click left
// focused must not start, pause, resume or stop a timer. Enter and clicks work as on any other button, and the focus is left alone.
import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ComponentProps } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { TimerButton } from './TimerButton';
import { Button } from './ui';

/** A focused Pause button that counts its presses. */
function pause(extra: Partial<ComponentProps<typeof TimerButton>> = {}) {
  const onClick = vi.fn();
  render(
    <TimerButton small variant="primary" title="Pause the task" onClick={onClick} {...extra}>
      Pause
    </TimerButton>,
  );
  const button = screen.getByRole('button', { name: 'Pause' });
  button.focus();
  return { button, onClick, user: userEvent.setup() };
}

describe('TimerButton', () => {
  it('is a real button drawn like the other buttons, and passes its props on', () => {
    const { button } = pause();
    expect(button.tagName).toBe('BUTTON');
    expect(button).toHaveAttribute('type', 'button');
    expect(button).toHaveClass('btn', 'btn-primary', 'btn-small');
    expect(button).toHaveAttribute('title', 'Pause the task');
    expect(button).toHaveFocus();
  });

  it('stays a submit button when it is one, and a disabled one stays disabled', () => {
    render(
      <form>
        <TimerButton type="submit">Start</TimerButton>
        <TimerButton disabled>Stop</TimerButton>
      </form>,
    );
    expect(screen.getByRole('button', { name: 'Start' })).toHaveAttribute('type', 'submit');
    expect(screen.getByRole('button', { name: 'Stop' })).toBeDisabled();
  });

  it.each([
    ['a Space going down', 'keyDown', { key: ' ', code: 'Space' }],
    ['a Space coming up', 'keyUp', { key: ' ', code: 'Space' }],
    ['a held Space repeating', 'keyDown', { key: ' ', code: 'Space', repeat: true }],
    ['a held Space coming up', 'keyUp', { key: ' ', code: 'Space', repeat: false }],
    ['Shift and Space', 'keyDown', { key: ' ', code: 'Space', shiftKey: true }],
    ['Ctrl and Space coming up', 'keyUp', { key: ' ', code: 'Space', ctrlKey: true }],
    ['Space known only by its key', 'keyDown', { key: ' ' }],
    ['Space known only by its code', 'keyUp', { code: 'Space' }],
    ['Space from a keyboard that reports no key', 'keyDown', { key: 'Unidentified', code: 'Space' }],
  ] as const)('refuses %s, so the browser never presses the button for it', (_what, kind, init) => {
    const { button, onClick } = pause();
    const fire = kind === 'keyDown' ? fireEvent.keyDown : fireEvent.keyUp;
    // `fireEvent` answers false when a handler cancelled the event, which is what stops the browser's own press.
    expect(fire(button, init)).toBe(false);
    expect(onClick).not.toHaveBeenCalled();
  });

  it.each(['Enter', 'Tab', 'Escape', 'ArrowDown', 'a', 'Shift', 'Control'])('leaves %s alone: Enter in particular must reach the browser', (key) => {
    const { button } = pause();
    expect(fireEvent.keyDown(button, { key })).toBe(true);
    expect(fireEvent.keyUp(button, { key })).toBe(true);
  });

  it('is not pressed by Space pressed, held with its repeats, or released, but is by Enter and by a click', async () => {
    const { button, onClick, user } = pause();
    await user.keyboard('[Space]');
    await user.keyboard('[Space>5]');
    await user.keyboard('[/Space]');
    expect(onClick).not.toHaveBeenCalled();
    await user.keyboard('{Enter}');
    expect(onClick).toHaveBeenCalledTimes(1);
    await user.click(button);
    expect(onClick).toHaveBeenCalledTimes(2);
  });

  it('keeps the focus where it was after a click, so the keyboard order is not broken', async () => {
    const { button, user } = pause();
    await user.tab({ shift: true });
    expect(button).not.toHaveFocus();
    await user.click(button);
    expect(button).toHaveFocus();
    await user.keyboard('{Enter}');
    expect(button).toHaveFocus();
  });

  it('is what tells a timer button from a plain one: a plain Button is pressed by Space in this very harness', async () => {
    const onClick = vi.fn();
    render(<Button onClick={onClick}>Details</Button>);
    screen.getByRole('button', { name: 'Details' }).focus();
    await userEvent.setup().keyboard('[Space]');
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('takes no key handlers of its own, so nothing can bring Space back', () => {
    const onKeyDown = vi.fn();
    render(
      // @ts-expect-error a timer button has no onKeyDown prop: its own handlers are the ones that refuse Space
      <TimerButton onKeyDown={onKeyDown}>Stop</TimerButton>,
    );
    const button = screen.getByRole('button', { name: 'Stop' });
    expect(fireEvent.keyDown(button, { key: ' ', code: 'Space' })).toBe(false);
    expect(onKeyDown).not.toHaveBeenCalled();
  });
});
