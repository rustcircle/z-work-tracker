// The in-app colour picker: a saturation/brightness area, a hue slider, R, G, B and hex fields, the
// curated swatches and recently used colours. Hand-written, no dependency, no native colour input.
// Used by the project form and the tag editor. Any colour is allowed; warnings never block.
import { useId, useState, type KeyboardEvent, type PointerEvent } from 'react';

import {
  MIN_VISIBLE_CONTRAST,
  PROJECT_PALETTE,
  areaPoint,
  hexToHsv,
  hexToRgb,
  huePoint,
  hsvToHex,
  normalizeHex,
  parseChannel,
  readableText,
  rgbToHex,
  similarColor,
  stepArea,
  stepHue,
  weakestContrast,
  type Hsv,
  type Neighbour,
} from '../lib/color';
import { loadRecent } from '../lib/recentColors';
import { THEMES, THEME_LABELS } from '../lib/themes';
import type { Theme } from '../lib/types';
import './colorPicker.css';

type FieldName = 'hex' | 'r' | 'g' | 'b';

export interface ColorPickerProps {
  /** Names the whole control for assistive technology, such as "Project colour". */
  label: string;
  /** The current colour as `#rrggbb`. */
  value: string;
  onChange: (hex: string) => void;
  /** Text shown on the preview, in the readable text colour. */
  sampleName?: string;
  /** Colours of the other projects (or tags) to warn about when this one looks too much like them. */
  neighbours?: readonly Neighbour[];
  neighbourNoun?: string;
  /** The theme whose backgrounds the colour is checked against. */
  theme?: Theme;
  /** A refusal from the backend, shown as plain text. */
  error?: string | null;
}

const pct = (n: number): number => Math.round(n * 100);

/** Radio group of swatches with arrow-key movement and one tab stop. */
function Swatches({ label, colors, value, onPick }: { label: string; colors: readonly string[]; value: string; onPick: (c: string) => void }) {
  const selected = colors.indexOf(value);
  const stop = selected >= 0 ? selected : 0;
  const move = (e: KeyboardEvent<HTMLButtonElement>, i: number): void => {
    const step = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 0;
    // Home and End go to the first and the last, as in any radio group.
    if (step === 0 && e.key !== 'Home' && e.key !== 'End') return;
    e.preventDefault();
    const next = e.key === 'Home' ? 0 : e.key === 'End' ? colors.length - 1 : (i + step + colors.length) % colors.length;
    const color = colors[next];
    if (!color) return;
    onPick(color);
    (e.currentTarget.parentElement?.children[next] as HTMLElement | undefined)?.focus();
  };
  return (
    <div className="swatches" role="radiogroup" aria-label={label}>
      {colors.map((c, i) => (
        <button
          key={c}
          type="button"
          role="radio"
          aria-checked={c === value}
          aria-label={`Colour ${c}`}
          title={c}
          tabIndex={i === stop ? 0 : -1}
          className={`swatch-btn ${c === value ? 'on' : ''}`}
          style={{ background: c }}
          onClick={() => onPick(c)}
          onKeyDown={(e) => move(e, i)}
        />
      ))}
    </div>
  );
}

export function ColorPicker({ label, value, onChange, sampleName = 'Sample', neighbours = [], neighbourNoun = 'project', theme = 'light', error = null }: ColorPickerProps) {
  const labelId = useId();
  const helpId = useId();
  const safe = normalizeHex(value) ?? '#000000';
  const [hsv, setHsv] = useState<Hsv>(() => hexToHsv(safe));
  const [draft, setDraft] = useState<{ field: FieldName; text: string } | null>(null);
  const [recent] = useState<string[]>(loadRecent);

  // A colour set from outside (a swatch, a reset) moves the area and the hue; a grey keeps the hue shown.
  if (hsvToHex(hsv) !== safe) setHsv(hexToHsv(safe, hsv.h));

  const rgb = hexToRgb(safe) ?? { r: 0, g: 0, b: 0 };

  function emit(hex: string): void {
    if (hex !== safe) onChange(hex);
  }
  function commit(next: Hsv): void {
    setHsv(next);
    emit(hsvToHex(next));
  }
  function pick(hex: string): void {
    setDraft(null);
    emit(hex);
  }

  const shown = (field: FieldName, derived: string): string => (draft?.field === field ? draft.text : derived);
  // Typing keeps the draft text (so "#12" can become "#123456") while the colour follows each valid value.
  function edit(field: FieldName, text: string): void {
    setDraft({ field, text });
    if (field === 'hex') {
      // A full six digits applies at once. Shorthand such as "abc" waits for Enter or leaving the field,
      // so typing "#808080" never passes through the colour "#880088".
      const hex = normalizeHex(text);
      if (hex && /^#?[0-9a-fA-F]{6}$/.test(text.trim())) emit(hex);
      return;
    }
    const n = parseChannel(text);
    if (n !== null) emit(rgbToHex({ ...rgb, [field]: n }));
  }
  /** Leaving a field (or Enter in the hex field) applies a shorthand colour, then shows the real value again. */
  function settle(): void {
    const hex = draft?.field === 'hex' ? normalizeHex(draft.text) : null;
    if (hex) emit(hex);
    setDraft(null);
  }
  const fieldError = (field: FieldName): string | null => {
    if (draft?.field !== field) return null;
    if (field === 'hex') return normalizeHex(draft.text) ? null : 'Enter a colour like #1a2b3c.';
    return parseChannel(draft.text) !== null ? null : 'Use a whole number from 0 to 255.';
  };

  function onAreaPointer(e: PointerEvent<HTMLDivElement>, start: boolean): void {
    if (!start && e.buttons !== 1) return;
    if (start) {
      e.currentTarget.focus();
      try {
        e.currentTarget.setPointerCapture(e.pointerId);
      } catch {
        // Capture is a nicety: without it a drag that leaves the area simply stops following.
      }
    }
    const r = e.currentTarget.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) return;
    commit(areaPoint(hsv, (e.clientX - r.left) / r.width, (e.clientY - r.top) / r.height));
  }
  function onHuePointer(e: PointerEvent<HTMLDivElement>, start: boolean): void {
    if (!start && e.buttons !== 1) return;
    if (start) {
      e.currentTarget.focus();
      try {
        e.currentTarget.setPointerCapture(e.pointerId);
      } catch {
        // See above.
      }
    }
    const r = e.currentTarget.getBoundingClientRect();
    if (r.width === 0) return;
    commit({ ...hsv, h: huePoint((e.clientX - r.left) / r.width) });
  }

  const tokens = THEMES[theme];
  const low = weakestContrast(safe, [tokens.bg, tokens.surface]);
  const similar = similarColor(safe, neighbours);
  const channelFields: { field: 'r' | 'g' | 'b'; label: string }[] = [
    { field: 'r', label: 'Red' },
    { field: 'g', label: 'Green' },
    { field: 'b', label: 'Blue' },
  ];
  const hexError = fieldError('hex');
  const hueNow = Math.round(hsv.h);

  return (
    <div className="cp" role="group" aria-labelledby={labelId}>
      <span className="field-label" id={labelId}>
        {label}
      </span>
      <div className="cp-main">
        <div className="cp-spectrum">
          <div
            className="cp-area"
            role="slider"
            tabIndex={0}
            aria-label="Saturation and brightness"
            aria-roledescription="2D slider"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={pct(hsv.s)}
            aria-valuetext={`Saturation ${pct(hsv.s)}%, brightness ${pct(hsv.v)}%`}
            aria-describedby={helpId}
            style={{ backgroundColor: `hsl(${hsv.h} 100% 50%)` }}
            onPointerDown={(e) => onAreaPointer(e, true)}
            onPointerMove={(e) => onAreaPointer(e, false)}
            onKeyDown={(e) => {
              if (e.ctrlKey || e.metaKey || e.altKey) return;
              const next = stepArea(hsv, e.key, e.shiftKey);
              if (next) {
                e.preventDefault();
                commit(next);
              }
            }}
          >
            <span className="cp-thumb" style={{ left: `${hsv.s * 100}%`, top: `${(1 - hsv.v) * 100}%`, background: safe }} />
          </div>
          <div
            className="cp-hue"
            role="slider"
            tabIndex={0}
            aria-label="Hue"
            aria-valuemin={0}
            aria-valuemax={360}
            aria-valuenow={hueNow}
            aria-valuetext={`${hueNow} degrees`}
            aria-describedby={helpId}
            onPointerDown={(e) => onHuePointer(e, true)}
            onPointerMove={(e) => onHuePointer(e, false)}
            onKeyDown={(e) => {
              if (e.ctrlKey || e.metaKey || e.altKey) return;
              const h = stepHue(hsv.h, e.key, e.shiftKey);
              if (h !== null) {
                e.preventDefault();
                commit({ ...hsv, h });
              }
            }}
          >
            <span className="cp-hue-thumb" style={{ left: `${(hsv.h / 360) * 100}%`, background: `hsl(${hsv.h} 100% 50%)` }} />
          </div>
        </div>

        <div className="cp-side">
          <div className="cp-preview" style={{ background: safe, color: readableText(safe) }} title={`Text on this colour is ${readableText(safe) === '#ffffff' ? 'white' : 'black'}`}>
            <span aria-hidden="true">{sampleName}</span>
          </div>
          <div className="cp-fields">
            <div className="cp-field cp-field-hex">
              <label className="field-label" htmlFor={`${labelId}-hex`}>
                Hex
              </label>
              <input
                id={`${labelId}-hex`}
                className="input"
                value={shown('hex', safe)}
                onChange={(e) => edit('hex', e.target.value)}
                onBlur={settle}
                onKeyDown={(e) => {
                  if (e.key !== 'Enter') return;
                  e.preventDefault();
                  settle();
                }}
                spellCheck={false}
                autoComplete="off"
                maxLength={9}
                aria-invalid={hexError ? true : undefined}
                aria-describedby={hexError ? `${labelId}-hex-err` : undefined}
              />
            </div>
            {channelFields.map(({ field, label: text }) => {
              const err = fieldError(field);
              return (
                <div className="cp-field" key={field}>
                  <label className="field-label" htmlFor={`${labelId}-${field}`}>
                    {text}
                  </label>
                  <input
                    id={`${labelId}-${field}`}
                    className="input"
                    inputMode="numeric"
                    value={shown(field, String(rgb[field]))}
                    onChange={(e) => edit(field, e.target.value)}
                    onBlur={() => setDraft(null)}
                    autoComplete="off"
                    maxLength={3}
                    aria-invalid={err ? true : undefined}
                    aria-describedby={err ? `${labelId}-${field}-err` : undefined}
                  />
                </div>
              );
            })}
          </div>
          {hexError && (
            <p className="field-error" id={`${labelId}-hex-err`} role="alert">
              {hexError}
            </p>
          )}
          {channelFields.map(({ field }) => {
            const err = fieldError(field);
            return err ? (
              <p className="field-error" id={`${labelId}-${field}-err`} role="alert" key={field}>
                {err}
              </p>
            ) : null;
          })}
        </div>
      </div>
      <p className="field-hint" id={helpId}>
        Arrow keys move the pointer by 1, Shift by 10 (15 degrees on the hue). Home, End, Page Up and Page Down jump.
      </p>

      <div className="cp-group">
        <span className="cp-sub">Suggested colours</span>
        <Swatches label="Suggested colours" colors={PROJECT_PALETTE} value={safe} onPick={pick} />
      </div>
      {recent.length > 0 && (
        <div className="cp-group">
          <span className="cp-sub">Recently used</span>
          <div className="swatches" role="group" aria-label="Recently used colours">
            {recent.map((c) => (
              <button key={c} type="button" className={`swatch-btn ${c === safe ? 'on' : ''}`} aria-pressed={c === safe} aria-label={`Recent colour ${c}`} title={c} style={{ background: c }} onClick={() => pick(c)} />
            ))}
          </div>
        </div>
      )}

      <div className="cp-notes" aria-live="polite">
        {similar && (
          <p className="field-warning" data-testid="cp-warn-similar">
            Close to {similar.name} ({similar.color}). Charts are harder to read when two {neighbourNoun}s look alike. You can still use it.
          </p>
        )}
        {low < MIN_VISIBLE_CONTRAST && (
          <p className="field-warning" data-testid="cp-warn-contrast">
            Low contrast against the {THEME_LABELS[theme]} theme background ({low.toFixed(1)} to 1). It may be hard to see in charts. The label text on it stays readable, and you can still use it.
          </p>
        )}
      </div>
      {error && (
        <p className="field-error" role="alert" data-testid="cp-error">
          {error}
        </p>
      )}
    </div>
  );
}
