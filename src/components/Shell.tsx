import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';

import { useAppState } from '../app/store';
import { api, events } from '../lib/api';
import { AnalysisTab } from '../features/analysis/AnalysisTab';
import { ExportDialog } from '../features/export/ExportDialog';
import { BillingTab } from '../features/billing/BillingTab';
import { ProjectsTab } from '../features/projects/ProjectsTab';
import { SettingsTab } from '../features/settings/SettingsTab';
import { EditStoreProvider } from '../features/tasks/editStore';
import { TaskRail } from '../features/tasks/TaskRail';
import { TimelineTab } from '../features/timeline/TimelineTab';
import { ActiveZoneBar } from '../features/zones';
import { Banners } from './Banners';
import { ClientZonePrompt } from './ClientZonePrompt';
import { IconDownload, IconEye, IconEyeOff } from './icons';
import { NavContext, type Nav, type TabId } from './nav';
import { Button } from './ui';
import { useCommands } from './useCommands';

const TABS: { id: TabId; label: string; render: () => ReactNode }[] = [
  { id: 'timeline', label: 'Timeline', render: () => <TimelineTab /> },
  { id: 'analysis', label: 'Analysis', render: () => <AnalysisTab /> },
  { id: 'billing', label: 'Billing', render: () => <BillingTab /> },
  { id: 'projects', label: 'Projects', render: () => <ProjectsTab /> },
  { id: 'settings', label: 'Settings', render: () => <SettingsTab /> },
];

function Brand() {
  return (
    <div className="brand">
      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="2" />
        <path d="M12 6v6l4 2" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
      </svg>
      <span>zWorkTracker</span>
    </div>
  );
}

export function Shell() {
  const { snapshot } = useAppState();
  const { act } = useCommands();
  const [tab, setTab] = useState<TabId>('timeline');
  const [focusProject, setFocusProject] = useState<string | null>(null);
  const [settingsSection, setSettingsSection] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);
  const [focusTask, setFocusTask] = useState<Nav['focusTask']>(null);
  const [continueTaskId, setContinueTaskId] = useState<string | null>(null);
  const [colorTarget, setColorTarget] = useState<Nav['colorTarget']>(null);
  const [tagIntent, setTagIntent] = useState<Nav['tagIntent']>(null);
  const [returnFocus, setReturnFocus] = useState<string | null>(null);
  const seq = useRef(0);
  const tabRefs = useRef(new Map<TabId, HTMLButtonElement>());
  const hide = snapshot.prefs.hideEarnings;

  const nav = useMemo<Nav>(
    () => ({
      tab,
      go: setTab,
      focusProject,
      openProject: (id) => {
        setFocusProject(id);
        setTab('projects');
      },
      clearFocusProject: () => setFocusProject(null),
      openSettings: (section) => {
        setSettingsSection(section);
        setTab('settings');
      },
      settingsSection,
      clearSettingsSection: () => setSettingsSection(null),
      focusTask,
      goToTask: (id, edit = false) => {
        seq.current += 1;
        setFocusTask({ id, edit, seq: seq.current });
      },
      clearFocusTask: () => setFocusTask(null),
      continueTaskId,
      openContinue: setContinueTaskId,
      clearContinue: () => setContinueTaskId(null),
      colorTarget,
      chooseColor: (kind, id) => {
        setColorTarget({ kind, id });
        if (kind === 'project') {
          setFocusProject(id);
          setTab('projects');
        } else {
          setSettingsSection('tags');
          setTab('settings');
        }
      },
      clearColorTarget: () => setColorTarget(null),
      tagIntent,
      startNewTag: (origin) => {
        setTagIntent({ origin, back: tab, createdId: null });
        setSettingsSection('tags');
        setTab('settings');
      },
      tagCreated: (id) => setTagIntent((t) => (t ? { ...t, createdId: id } : t)),
      backToTask: () => {
        if (tagIntent) {
          setTab(tagIntent.back);
          setReturnFocus(tagIntent.origin);
        }
      },
      returnFocus,
      clearReturnFocus: () => setReturnFocus(null),
      endTagIntent: () => setTagIntent(null),
    }),
    [tab, focusProject, settingsSection, focusTask, continueTaskId, colorTarget, tagIntent, returnFocus],
  );

  // A marker only the page can read: scripts/perf-native.mjs times cold start up to here.
  useEffect(() => {
    performance.mark('z-first-render');
  }, []);

  // The tray's Resume on a cold launch: open the form for a new linked task and start nothing.
  const tasksRef = useRef(snapshot.tasks);
  useEffect(() => {
    tasksRef.current = snapshot.tasks;
  });
  useEffect(() => {
    const unlisten = events.onColdResume((taskId) => {
      if (tasksRef.current.some((t) => t.id === taskId && t.state === 'paused')) setContinueTaskId(taskId);
    });
    return () => void unlisten.then((f) => f()).catch(() => undefined);
  }, []);

  const onKey = useCallback(
    (e: KeyboardEvent<HTMLButtonElement>) => {
      const i = TABS.findIndex((t) => t.id === tab);
      const next = e.key === 'ArrowRight' ? (i + 1) % TABS.length : e.key === 'ArrowLeft' ? (i + TABS.length - 1) % TABS.length : e.key === 'Home' ? 0 : e.key === 'End' ? TABS.length - 1 : -1;
      if (next < 0) return;
      e.preventDefault();
      const t = TABS[next];
      if (t) {
        setTab(t.id);
        tabRefs.current.get(t.id)?.focus();
      }
    },
    [tab],
  );

  const current = TABS.find((t) => t.id === tab) ?? (TABS[0] as (typeof TABS)[number]);

  return (
    <NavContext.Provider value={nav}>
      <EditStoreProvider>
      <div className="app">
        <header className="app-header">
          <Brand />
          <ActiveZoneBar />
          <div className="spacer" />
          <button type="button" className={`toggle-btn ${hide ? 'on' : ''}`} aria-pressed={hide} onClick={() => void act(() => api.setHideEarnings(!hide))} title={hide ? 'Earnings are masked everywhere. Click to show them.' : 'Mask every amount on screen'}>
            {hide ? <IconEyeOff /> : <IconEye />}
            <span>Hide earnings</span>
          </button>
          <Button icon={<IconDownload />} onClick={() => setExporting(true)}>
            Export
          </Button>
        </header>
        <Banners />
        <div className="app-body">
          <TaskRail />
          <main className="main">
            <div className="tabbar" role="tablist" aria-label="Sections">
              {TABS.map((t) => (
                <button
                  key={t.id}
                  ref={(el) => {
                    if (el) tabRefs.current.set(t.id, el);
                    else tabRefs.current.delete(t.id);
                  }}
                  type="button"
                  role="tab"
                  id={`tab-${t.id}`}
                  aria-selected={tab === t.id}
                  aria-controls={`panel-${t.id}`}
                  tabIndex={tab === t.id ? 0 : -1}
                  className={`tab ${tab === t.id ? 'on' : ''}`}
                  onClick={() => setTab(t.id)}
                  onKeyDown={onKey}
                >
                  {t.label}
                </button>
              ))}
            </div>
            <div className="tabpanel" role="tabpanel" id={`panel-${current.id}`} aria-labelledby={`tab-${current.id}`}>
              {current.render()}
            </div>
          </main>
        </div>
        <ExportDialog open={exporting} onClose={() => setExporting(false)} />
        <ClientZonePrompt />
      </div>
      </EditStoreProvider>
    </NavContext.Provider>
  );
}
