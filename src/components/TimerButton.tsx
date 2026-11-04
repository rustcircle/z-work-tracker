import type { ComponentProps, KeyboardEvent } from 'react';

import { Button } from './ui';

/** A button's props without key handlers: the two this component sets are the whole point of it, and nothing may replace them. */
type TimerButtonProps = Omit<ComponentProps<typeof Button>, 'onKeyDown' | 'onKeyUp'>;

/** Space under either name a keyboard or an input method may give it, with or without Shift, Ctrl or Alt. */
const isSpace = (e: KeyboardEvent<HTMLButtonElement>): boolean => e.key === ' ' || e.code === 'Space';

/** Cancelling the event is what stops the browser's own press of the focused button. */
const refuseSpace = (e: KeyboardEvent<HTMLButtonElement>): void => {
  if (isSpace(e)) e.preventDefault();
};

/**
 * The button of anything that starts, pauses, resumes, stops or continues a timer, asks another computer to pause one, or ends time
 * another computer left running. It never reacts to the Space key.
 *
 * The app is worked with the mouse, and a click leaves its button focused, and still enabled when the backend refused the click. A
 * Space pressed later for something else would then press it again: the browser presses a focused button as Space comes up, and a
 * held Space keeps going down. So Space is cancelled on the way down, repeats included, and on the way up, since engines differ on
 * which of the two counts. It stays a real <button>: a click and Enter press it as on any other, and nothing here blurs it, so the
 * keyboard order is kept.
 */
export function TimerButton(props: TimerButtonProps) {
  return <Button {...props} onKeyDown={refuseSpace} onKeyUp={refuseSpace} />;
}
