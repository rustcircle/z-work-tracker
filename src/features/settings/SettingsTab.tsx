import { useEffect, useRef, type ReactNode } from 'react';

import { useNav } from '../../components/nav';
import { Card } from '../../components/ui';
import { AboutSection, AutostartSection, TargetsSection } from './OtherSections';
import { RoundingSection } from './RoundingSection';
import { ShiftsSection } from './ShiftsSection';
import { SyncSection } from './SyncSection';
import { ThemeSection } from './ThemeSection';
import { ZonesSection } from './ZonesSection';

const SECTIONS: { id: string; title: string; render: () => ReactNode }[] = [
  { id: 'appearance', title: 'Appearance', render: () => <ThemeSection /> },
  { id: 'zones', title: 'Time zones', render: () => <ZonesSection /> },
  { id: 'rounding', title: 'Rounding', render: () => <RoundingSection /> },
  { id: 'targets', title: 'Targets', render: () => <TargetsSection /> },
  { id: 'shifts', title: 'Shifts', render: () => <ShiftsSection /> },
  { id: 'startup', title: 'Startup', render: () => <AutostartSection /> },
  { id: 'sync', title: 'Sync between devices', render: () => <SyncSection /> },
  { id: 'about', title: 'About', render: () => <AboutSection /> },
];

export function SettingsTab() {
  const nav = useNav();
  const root = useRef<HTMLDivElement | null>(null);
  const target = nav.settingsSection;

  useEffect(() => {
    if (!target) return;
    root.current?.querySelector<HTMLElement>(`#settings-${target}`)?.scrollIntoView?.({ block: 'start' });
  }, [target]);

  const jump = (id: string) => root.current?.querySelector<HTMLElement>(`#settings-${id}`)?.scrollIntoView?.({ block: 'start', behavior: window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });

  return (
    <div className="page settings" role="region" aria-label="Settings" ref={root}>
      <div className="page-head">
        <h2>Settings</h2>
        <nav className="jump" aria-label="Jump to a section">
          {SECTIONS.map((s) => (
            <button key={s.id} type="button" className="link" onClick={() => jump(s.id)}>
              {s.title}
            </button>
          ))}
        </nav>
      </div>
      {SECTIONS.map((s) => (
        <Card key={s.id} className="page-card" label={s.title}>
          <h3 id={`settings-${s.id}`} className="section-title">
            {s.title}
          </h3>
          {s.render()}
        </Card>
      ))}
    </div>
  );
}
