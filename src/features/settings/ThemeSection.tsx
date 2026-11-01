import { useAppState } from '../../app/store';
import { api } from '../../lib/api';
import { MICA_THEMES, THEMES, THEME_LABELS } from '../../lib/themes';
import type { Theme } from '../../lib/types';
import { Switch, onRadioKeyDown } from '../../components/ui';
import { useCommands } from '../../components/useCommands';

const ORDER: Theme[] = ['light', 'solarizedLight', 'solarizedDark', 'dark'];

export function ThemeSection() {
  const { snapshot } = useAppState();
  const { act } = useCommands();
  return (
    <div>
      <div className="theme-grid" role="radiogroup" aria-label="Theme" onKeyDown={onRadioKeyDown}>
        {ORDER.map((t) => {
          const tok = THEMES[t];
          const on = snapshot.prefs.theme === t;
          return (
            <button key={t} type="button" role="radio" aria-checked={on} tabIndex={on ? 0 : -1} className={`theme-card ${on ? 'on' : ''}`} onClick={() => void act(() => api.setTheme(t))}>
              <span className="theme-preview" style={{ background: tok.bg, borderColor: tok.border }} aria-hidden="true">
                <span style={{ background: tok.surface, borderColor: tok.border }} className="theme-preview-card">
                  <span style={{ background: tok.accent }} />
                  <span style={{ background: tok.textMuted }} />
                  <span style={{ background: tok.cWorked }} />
                </span>
              </span>
              <span className="theme-name">{THEME_LABELS[t]}</span>
            </button>
          );
        })}
      </div>
      <MicaSwitch />
      <p className="field-hint">The theme is stored on this device only and never follows the operating system.</p>
    </div>
  );
}

/** The Windows 11 Mica backdrop. Off by default, and it says why it is unavailable instead of hiding. */
function MicaSwitch() {
  const { snapshot } = useAppState();
  const { act } = useCommands();
  const { mica, micaAvailable, theme } = snapshot.prefs;
  const hint = !micaAvailable
    ? 'Not available on this computer: Mica needs Windows 11.'
    : MICA_THEMES.includes(theme)
      ? 'Lets your wallpaper tint the window background. Panels and text stay opaque.'
      : 'Shows only with the Light and Dark themes. Solarized keeps its exact colours and stays opaque.';
  return (
    <div className="mica-switch" data-testid="mica-setting">
      <Switch checked={mica} disabled={!micaAvailable} label="Windows 11 Mica backdrop" hint={hint} onChange={(on) => void act(() => api.setMica(on))} />
    </div>
  );
}
