import { useEffect, useRef, type ReactNode } from 'react';

import { useNav } from '../../components/nav';
import { Button, Card } from '../../components/ui';
import { IconBack } from '../../components/icons';
import { RerunSetup } from '../setup/RerunSetup';
import { AuditSection } from './AuditSection';
import { BackupsSection } from './BackupsSection';
import { BillingPrefixSection } from './BillingPrefixSection';
import { RemindersSection } from './RemindersSection';
import { TagsSection } from './TagsSection';
import { TemplatesSection } from './TemplatesSection';
import { AboutSection, AutostartSection, TargetsSection } from './OtherSections';
import { RoundingSection } from './RoundingSection';
import { ShiftsSection } from './ShiftsSection';
import { SyncSection } from './SyncSection';
import { ThemeSection } from './ThemeSection';
import { VersionsSection } from './VersionsSection';
import { ZonesSection } from './ZonesSection';

const SECTIONS: { id: string; title: string; render: () => ReactNode }[] = [
  { id: 'appearance', title: 'Appearance', render: () => <ThemeSection /> },
  { id: 'zones', title: 'Time zones', render: () => <ZonesSection /> },
  { id: 'rounding', title: 'Rounding', render: () => <RoundingSection /> },
  { id: 'targets', title: 'Targets', render: () => <TargetsSection /> },
  { id: 'shifts', title: 'Shifts', render: () => <ShiftsSection /> },
  { id: 'startup', title: 'Start with Windows', render: () => <AutostartSection /> },
  { id: 'tags', title: 'Tags', render: () => <TagsSection /> },
  { id: 'templates', title: 'Templates', render: () => <TemplatesSection /> },
  { id: 'billing', title: 'Billing references', render: () => <BillingPrefixSection /> },
  { id: 'reminders', title: 'Time away and reminders', render: () => <RemindersSection /> },
  { id: 'sync', title: 'Sync between devices', render: () => <SyncSection /> },
  { id: 'backups', title: 'Backups', render: () => <BackupsSection /> },
  { id: 'versions', title: 'Versions', render: () => <VersionsSection /> },
  { id: 'audit', title: 'History of changes', render: () => <AuditSection /> },
  { id: 'setup', title: 'Setup', render: () => <RerunSetup /> },
  { id: 'about', title: 'About', render: () => <AboutSection /> },
];

export function SettingsTab() {
  const nav = useNav();
  const root = useRef<HTMLDivElement | null>(null);
  const target = nav.settingsSection;
  const { clearSettingsSection } = nav;

  // Scrolls to the requested section once, then forgets it, so asking for the same section again works.
  useEffect(() => {
    if (!target) return;
    root.current?.querySelector<HTMLElement>(`#settings-${target}`)?.scrollIntoView?.({ block: 'start' });
    clearSettingsSection();
  }, [target, clearSettingsSection]);

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
      {nav.tagIntent && (
        <div className="banner banner-info back-to-task" role="status" data-testid="back-to-task-bar">
          <span>{nav.tagIntent.createdId ? 'Tag added and ticked on your task. Your unsaved task is as you left it.' : 'Adding a tag for your task. What you typed there is kept.'}</span>
          <Button id="back-to-task" variant={nav.tagIntent.createdId ? 'primary' : 'secondary'} icon={<IconBack />} onClick={nav.backToTask}>
            Back to task
          </Button>
        </div>
      )}
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
