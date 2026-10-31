import { fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { PROJECT_PALETTE } from '../lib/color';
import { RECENT_KEY } from '../lib/recentColors';
import type { Theme } from '../lib/types';
import { ColorPicker } from './ColorPicker';

afterEach(() => {
  vi.restoreAllMocks();
  window.localStorage.clear();
});

function Harness({ initial = '#2563eb', neighbours = [], theme = 'light', error = null, onChange }: { initial?: string; neighbours?: { name: string; color: string }[]; theme?: Theme; error?: string | null; onChange?: (c: string) => void }) {
  const [value, setValue] = useState(initial);
  return (
    <>
      <ColorPicker
        label="Project colour"
        value={value}
        onChange={(c) => {
          setValue(c);
          onChange?.(c);
        }}
        sampleName="Brand refresh"
        neighbours={neighbours}
        theme={theme}
        error={error}
      />
      <output data-testid="value">{value}</output>
    </>
  );
}

const area = () => screen.getByRole('slider', { name: 'Saturation and brightness' });
const hue = () => screen.getByRole('slider', { name: 'Hue' });
const hex = () => screen.getByRole('textbox', { name: 'Hex' }) as HTMLInputElement;
const channel = (name: 'Red' | 'Green' | 'Blue') => screen.getByRole('textbox', { name }) as HTMLInputElement;
const value = () => screen.getByTestId('value').textContent;

describe('ColorPicker: sliders and the keyboard', () => {
  it('exposes the area and the hue as labelled sliders with values and text', () => {
    render(<Harness initial="#ff0000" />);
    expect(area()).toHaveAttribute('aria-valuenow', '100');
    expect(area()).toHaveAttribute('aria-valuetext', 'Saturation 100%, brightness 100%');
    expect(area()).toHaveAttribute('aria-roledescription', '2D slider');
    expect(hue()).toHaveAttribute('aria-valuenow', '0');
    expect(hue()).toHaveAttribute('aria-valuemax', '360');
    expect(hue()).toHaveAttribute('aria-valuetext', '0 degrees');
    expect(screen.getByRole('group', { name: 'Project colour' })).toBeInTheDocument();
  });

  it('arrow keys move the area, Shift moves it further, and the value, fields and ARIA text all follow', async () => {
    const user = userEvent.setup();
    const seen: string[] = [];
    render(<Harness initial="#ff0000" onChange={(c) => seen.push(c)} />);
    area().focus();
    await user.keyboard('{Shift>}{ArrowDown}{/Shift}');
    expect(value()).toBe('#e60000');
    expect(channel('Red').value).toBe('230');
    expect(area()).toHaveAttribute('aria-valuetext', 'Saturation 100%, brightness 90%');
    await user.keyboard('{ArrowLeft}');
    expect(area()).toHaveAttribute('aria-valuetext', 'Saturation 99%, brightness 90%');
    await user.keyboard('{Home}');
    expect(value()).toBe('#e6e6e6');
    expect(channel('Green').value).toBe('230');
    await user.keyboard('{End}{PageDown}');
    expect(area()).toHaveAttribute('aria-valuetext', 'Saturation 100%, brightness 80%');
    await user.keyboard('{PageUp}{PageUp}');
    expect(area()).toHaveAttribute('aria-valuetext', 'Saturation 100%, brightness 100%');
    expect(seen.every((c) => /^#[0-9a-f]{6}$/.test(c))).toBe(true);
  });

  it('keys it does not use are left alone', async () => {
    const user = userEvent.setup();
    const seen: string[] = [];
    render(<Harness onChange={(c) => seen.push(c)} />);
    area().focus();
    await user.keyboard('a{Enter}');
    hue().focus();
    await user.keyboard('x');
    expect(seen).toEqual([]);
  });

  it('the hue slider steps by 1 degree, 15 with Shift, 30 with the page keys, and Home/End go to the ends', async () => {
    const user = userEvent.setup();
    render(<Harness initial="#ff0000" />);
    hue().focus();
    await user.keyboard('{ArrowRight}');
    expect(hue()).toHaveAttribute('aria-valuenow', '1');
    await user.keyboard('{Shift>}{ArrowRight}{/Shift}');
    expect(hue()).toHaveAttribute('aria-valuenow', '16');
    await user.keyboard('{PageUp}');
    expect(hue()).toHaveAttribute('aria-valuenow', '46');
    await user.keyboard('{Home}');
    expect(hue()).toHaveAttribute('aria-valuenow', '0');
    expect(value()).toBe('#ff0000');
    await user.keyboard('{End}');
    expect(hue()).toHaveAttribute('aria-valuenow', '360');
    expect(value()).toBe('#ff0000');
    await user.keyboard('{ArrowLeft}');
    expect(hue()).toHaveAttribute('aria-valuenow', '359');
    expect(value()).toBe('#ff0004');
  });

  it('a pointer press in the area picks that saturation and brightness', () => {
    render(<Harness initial="#ff0000" />);
    const el = area();
    el.getBoundingClientRect = () => ({ x: 10, y: 20, left: 10, top: 20, width: 200, height: 100, right: 210, bottom: 120, toJSON: () => ({}) });
    fireEvent.pointerDown(el, { clientX: 110, clientY: 70, pointerId: 1, buttons: 1 });
    expect(area()).toHaveAttribute('aria-valuetext', 'Saturation 50%, brightness 50%');
    expect(value()).toBe('#804040');
  });

  it('a grey has no hue, so the hue slider stays where it was', async () => {
    const user = userEvent.setup();
    render(<Harness initial="#2563eb" />);
    const before = hue().getAttribute('aria-valuenow');
    expect(Number(before)).toBeGreaterThan(200);
    await user.clear(hex());
    await user.type(hex(), '#808080');
    expect(value()).toBe('#808080');
    expect(hue()).toHaveAttribute('aria-valuenow', before);
  });
});

describe('ColorPicker: hex and RGB fields', () => {
  it('typing a hex value moves the RGB fields, the area and the hue at once', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.clear(hex());
    await user.type(hex(), '#00FF00');
    expect(value()).toBe('#00ff00');
    expect([channel('Red').value, channel('Green').value, channel('Blue').value]).toEqual(['0', '255', '0']);
    expect(hue()).toHaveAttribute('aria-valuenow', '120');
    expect(area()).toHaveAttribute('aria-valuetext', 'Saturation 100%, brightness 100%');
  });

  it('accepts shorthand and a missing hash, and always sends #rrggbb in lower case', async () => {
    const user = userEvent.setup();
    const seen: string[] = [];
    render(<Harness onChange={(c) => seen.push(c)} />);
    await user.clear(hex());
    await user.type(hex(), 'ABC');
    expect(value()).toBe('#2563eb'); // shorthand waits for Enter or leaving the field
    await user.tab();
    expect(value()).toBe('#aabbcc');
    expect(channel('Blue').value).toBe('204');
    await user.clear(hex());
    await user.type(hex(), 'FF8800');
    expect(value()).toBe('#ff8800'); // six digits apply at once, no hash needed
    await user.clear(hex());
    await user.type(hex(), '#0f0{Enter}');
    expect(value()).toBe('#00ff00');
    expect(hex().value).toBe('#00ff00');
    expect(seen).toEqual(['#aabbcc', '#ff8800', '#00ff00']);
  });

  it('a half-typed value is not an error until it is wrong, and typing a number moves the colour as it goes', async () => {
    const user = userEvent.setup();
    render(<Harness initial="#102030" />);
    await user.clear(channel('Green'));
    await user.type(channel('Green'), '25');
    expect(value()).toBe('#101930');
    await user.type(channel('Green'), '6');
    expect(screen.getByRole('alert')).toHaveTextContent('Use a whole number from 0 to 255.');
    expect(value()).toBe('#101930');
  });

  it('typing RGB values updates the hex field', async () => {
    const user = userEvent.setup();
    render(<Harness initial="#000000" />);
    await user.clear(channel('Red'));
    await user.type(channel('Red'), '255');
    await user.clear(channel('Blue'));
    await user.type(channel('Blue'), '16');
    expect(value()).toBe('#ff0010');
    expect(hex().value).toBe('#ff0010');
  });

  it('refuses invalid hex without changing the colour, says why, and puts the old value back on blur', async () => {
    const user = userEvent.setup();
    const seen: string[] = [];
    render(<Harness onChange={(c) => seen.push(c)} />);
    await user.clear(hex());
    await user.type(hex(), 'zzz');
    expect(hex()).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByRole('alert')).toHaveTextContent('Enter a colour like #1a2b3c.');
    expect(value()).toBe('#2563eb');
    expect(seen).toEqual([]);
    await user.tab();
    expect(hex().value).toBe('#2563eb');
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it.each(['256', '-1', '1.5', 'abc', '1e2'])('refuses %j in an RGB field and leaves the colour alone', (bad) => {
    render(<Harness initial="#102030" />);
    fireEvent.change(channel('Green'), { target: { value: bad } });
    expect(screen.getByRole('alert')).toHaveTextContent('Use a whole number from 0 to 255.');
    expect(value()).toBe('#102030');
    fireEvent.blur(channel('Green'));
    expect(channel('Green').value).toBe('32');
  });

  it('an empty field is not an error until it is wrong, and does not change the colour', async () => {
    const user = userEvent.setup();
    render(<Harness initial="#102030" />);
    await user.clear(channel('Red'));
    expect(value()).toBe('#102030');
  });
});

describe('ColorPicker: swatches and recent colours', () => {
  it('has every curated colour as a radio, the current one checked, and arrow keys move between them', async () => {
    const user = userEvent.setup();
    render(<Harness initial={PROJECT_PALETTE[0]} />);
    const radios = screen.getAllByRole('radio');
    expect(radios.map((r) => r.getAttribute('aria-label'))).toEqual(PROJECT_PALETTE.map((c) => `Colour ${c}`));
    expect(radios[0]).toBeChecked();
    radios[0]?.focus();
    await user.keyboard('{ArrowRight}');
    expect(value()).toBe(PROJECT_PALETTE[1]);
    expect(screen.getByRole('radio', { name: `Colour ${PROJECT_PALETTE[1]}` })).toBeChecked();
    expect(screen.getByRole('radio', { name: `Colour ${PROJECT_PALETTE[1]}` })).toHaveFocus();
    await user.keyboard('{ArrowLeft}{ArrowLeft}');
    expect(value()).toBe(PROJECT_PALETTE.at(-1));
    await user.click(screen.getByRole('radio', { name: 'Colour #dc2626' }));
    expect(value()).toBe('#dc2626');
  });

  it('a colour that is not on the palette leaves no swatch checked, yet one stays reachable by Tab', () => {
    render(<Harness initial="#123456" />);
    const radios = screen.getAllByRole('radio');
    expect(radios.some((r) => r.getAttribute('aria-checked') === 'true')).toBe(false);
    expect(radios.filter((r) => r.getAttribute('tabindex') === '0')).toHaveLength(1);
  });

  it('shows recently used colours from this device and picks one on click', async () => {
    window.localStorage.setItem(RECENT_KEY, JSON.stringify(['#abcdef', '#123456', 'junk']));
    const user = userEvent.setup();
    render(<Harness />);
    const group = screen.getByRole('group', { name: 'Recently used colours' });
    expect(within(group).getAllByRole('button').map((b) => b.getAttribute('aria-label'))).toEqual(['Recent colour #abcdef', 'Recent colour #123456']);
    await user.click(within(group).getByRole('button', { name: 'Recent colour #123456' }));
    expect(value()).toBe('#123456');
    expect(within(group).getByRole('button', { name: 'Recent colour #123456' })).toHaveAttribute('aria-pressed', 'true');
  });

  it('has no recent group when nothing was used yet, and works when storage throws', async () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('storage is blocked');
    });
    const user = userEvent.setup();
    render(<Harness />);
    expect(screen.queryByRole('group', { name: 'Recently used colours' })).toBeNull();
    await user.click(screen.getByRole('radio', { name: 'Colour #059669' }));
    expect(value()).toBe('#059669');
  });
});

describe('ColorPicker: warnings never block', () => {
  it('warns when the colour is close to another project, names it, and still lets the colour through', async () => {
    const user = userEvent.setup();
    render(<Harness initial="#dc2626" neighbours={[{ name: 'Website', color: '#dc2627' }]} />);
    const warn = screen.getByTestId('cp-warn-similar');
    expect(warn).toHaveTextContent('Close to Website (#dc2627)');
    expect(warn).toHaveTextContent('You can still use it');
    await user.click(screen.getByRole('radio', { name: 'Colour #059669' }));
    expect(screen.queryByTestId('cp-warn-similar')).toBeNull();
    await user.clear(hex());
    await user.type(hex(), '#dc2628');
    expect(value()).toBe('#dc2628');
    expect(screen.getByTestId('cp-warn-similar')).toBeInTheDocument();
  });

  it('warns on low contrast against the theme background, per theme, and not for the curated colours', () => {
    const light = render(<Harness initial="#fde047" theme="light" />);
    expect(screen.getByTestId('cp-warn-contrast')).toHaveTextContent('Low contrast against the Light theme background');
    light.unmount();
    const dark = render(<Harness initial="#1e1f22" theme="dark" />);
    expect(screen.getByTestId('cp-warn-contrast')).toHaveTextContent('Dark theme background');
    dark.unmount();
    for (const theme of ['light', 'solarizedLight', 'solarizedDark', 'dark'] as const) {
      for (const c of PROJECT_PALETTE) {
        const r = render(<Harness initial={c} theme={theme} />);
        expect(screen.queryByTestId('cp-warn-contrast'), `${c} in ${theme}`).toBeNull();
        r.unmount();
      }
    }
  });

  it('the live region announces warnings politely', () => {
    render(<Harness initial="#fde047" />);
    expect(screen.getByTestId('cp-warn-contrast').parentElement).toHaveAttribute('aria-live', 'polite');
  });
});

describe('ColorPicker: refusals', () => {
  it('shows a refusal from the backend as plain text, never as markup', () => {
    const { container } = render(<Harness error={'a color must look like <b>#1a2b3c</b><img src=x onerror=alert(1)>'} />);
    expect(screen.getByTestId('cp-error')).toHaveTextContent('<b>#1a2b3c</b><img src=x onerror=alert(1)>');
    expect(container.querySelector('b')).toBeNull();
    expect(container.querySelector('img')).toBeNull();
    expect(screen.getByRole('alert')).toBeInTheDocument();
  });
});
