import { useAppState } from '../../app/store';
import { api } from '../../lib/api';
import { THEMES, THEME_LABELS } from '../../lib/themes';
import type { Theme } from '../../lib/types';
import { useCommands } from '../../components/useCommands';

const ORDER: Theme[] = ['light', 'solarizedLight', 'solarizedDark', 'dark'];

export function ThemeSection() {
  const { snapshot } = useAppState();
  const { act } = useCommands();
  return (
    <div>
      <div className="theme-grid" role="radiogroup" aria-label="Theme">
        {ORDER.map((t) => {
          const tok = THEMES[t];
          const on = snapshot.prefs.theme === t;
          return (
            <button key={t} type="button" role="radio" aria-checked={on} className={`theme-card ${on ? 'on' : ''}`} onClick={() => void act(() => api.setTheme(t))}>
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
      <p className="field-hint">The theme is stored on this device only and never follows the operating system.</p>
    </div>
  );
}
