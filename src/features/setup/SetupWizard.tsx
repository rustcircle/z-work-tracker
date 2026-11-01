// First-run setup: a full page that stands in for the Shell. Every step has defaults, Back, Skip, and a
// "Finish with defaults" that ends it in one click. Each step writes through the normal validated commands as
// it is left, and the step is saved so an interrupted setup resumes. It logs no time.
import { useEffect, useRef, useState } from 'react';

import { useApp } from '../../app/store';
import { api } from '../../lib/api';
import { ruleFor } from '../../lib/billing';
import { normalizeHex, suggestColor } from '../../lib/color';
import { errorMessage } from '../../lib/errorMessage';
import { dayOf, zoneLabel } from '../../lib/tz';
import type { Currency, FolderPreview, RoundMethod } from '../../lib/types';
import { ColorPicker } from '../../components/ColorPicker';
import { useColorNotices } from '../../components/colorNotice';
import { plural } from '../../components/format';
import { IconBack } from '../../components/icons';
import { RoundingFields, incrementLabel, METHOD_LABEL, type RoundingValue } from '../../components/RoundingFields';
import { Button, Field } from '../../components/ui';
import { useCommands } from '../../components/useCommands';
import { parsePrice, validateProjectName } from '../projects/projectLogic';
import { AutostartSection } from '../settings/OtherSections';
import { PRESETS } from '../settings/shiftLogic';
import { SyncChooser, folderLabel } from '../settings/SyncChooser';
import { ThemeSection } from '../settings/ThemeSection';
import { THEME_LABELS } from '../../lib/themes';
import { ZonePickerDialog } from '../zones';
import { OPTIONAL_STEPS, STEPS, STEP_TITLE, resumeAt, ruleSentence, ruleTable, stepIndex, visibleSteps, type StepId } from './setupSteps';
import './setup.css';

interface Props {
  /** Called once setup is finished, so the app shows the Shell. */
  onFinished: () => void;
  /** Opened from Settings: every step is shown, and the saved step is left alone. */
  rerun?: boolean;
}

type Previews = Map<string, FolderPreview | 'error'>;

export function SetupWizard({ onFinished, rerun = false }: Props) {
  const { snapshot, zones, nowSec, adopt } = useApp();
  const { act } = useCommands();
  const notices = useColorNotices();
  const today = dayOf(nowSec, zones.active);

  // Another computer's folder with data is offered first. Each detected folder is looked at once.
  const [previews, setPreviews] = useState<Previews>(new Map());
  const looked = useRef(new Set<string>());
  useEffect(() => {
    for (const d of snapshot.sync.detected) {
      if (looked.current.has(d.root)) continue;
      looked.current.add(d.root);
      api.previewSyncFolder(d.root).then(
        (p) => setPreviews((m) => new Map(m).set(d.root, p)),
        () => setPreviews((m) => new Map(m).set(d.root, 'error')),
      );
    }
  }, [snapshot.sync.detected]);
  const withData = snapshot.sync.detected.filter((d) => {
    const p = previews.get(d.root);
    return p !== undefined && p !== 'error' && p.hasData && !snapshot.sync.targets.some((t) => t.root === d.root);
  });
  const base = visibleSteps(snapshot, { offerConnect: withData.length > 0, skipAnswered: !rerun });

  const [at, setAt] = useState<StepId>(() => (rerun ? 'welcome' : resumeAt(snapshot.setup.step, visibleSteps(snapshot, { offerConnect: false, skipAnswered: true }))));
  // A step the user has opened stays in the walk even when what they just did makes the data answer it, so Back
  // and the progress count stay put. Steps they never opened and the data answers are left out.
  const [opened, setOpened] = useState<ReadonlySet<StepId>>(() => new Set([at]));
  const steps = STEPS.filter((id) => base.includes(id) || (id !== 'connect' && opened.has(id)));
  const current = at;
  const position = Math.max(0, steps.indexOf(current));
  const heading = useRef<HTMLHeadingElement | null>(null);
  useEffect(() => {
    heading.current?.focus();
  }, [current]);

  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Step state kept while the user goes back and forth.
  const [rounding, setRounding] = useState<RoundingValue>(() => {
    const r = ruleFor(snapshot.rounding, '', today);
    return { minutes: r.incrementMinutes, method: r.method };
  });
  const [name, setName] = useState('');
  const [color, setColor] = useState(() => suggestColor(snapshot.projects.map((p) => p.color)));
  const [price, setPrice] = useState('');
  const [currency, setCurrency] = useState<Currency>(snapshot.prefs.lastCurrency ?? 'EUR');
  const [made, setMade] = useState<{ project: string | null; shifts: string[] }>({ project: null, shifts: [] });
  const [ticked, setTicked] = useState<string[]>([]);
  const [pick, setPick] = useState<'my' | 'client' | null>(null);
  const [touched, setTouched] = useState(false);

  const go = (id: StepId): void => {
    setError(null);
    setTouched(false);
    setOpened((o) => new Set(o).add(id));
    setAt(id);
    if (!rerun) void act(() => api.setSetupStep(stepIndex(id)));
  };
  const after = (id: StepId): StepId => steps.find((s) => stepIndex(s) > stepIndex(id)) ?? 'summary';
  const next = (): void => go(after(current));
  const back = (): void => {
    const i = steps.indexOf(current);
    if (i > 0) go(steps[i - 1] as StepId);
  };

  async function finish(): Promise<void> {
    setBusy(true);
    try {
      // A rerun has nothing to finish: the first run was finished long ago and no state changes.
      if (rerun || (await act(() => api.finishSetup()))) onFinished();
    } finally {
      setBusy(false);
    }
  }

  const rule = ruleFor(snapshot.rounding, '', today);
  const rounded = rounding.minutes !== rule.incrementMinutes || (rounding.minutes > 0 && rounding.method !== rule.method);
  const nameError = name.trim() === '' ? null : validateProjectName(name, snapshot.projects, null);
  const priceResult = parsePrice(price);
  const priceError = name.trim() !== '' && !priceResult.ok ? priceResult.error : null;

  /** Writes what this step holds through the normal commands. Returns false when something was refused. */
  async function save(id: StepId): Promise<boolean> {
    setError(null);
    try {
      if (id === 'rules' && rounded) {
        const ok = await act(() => api.setRounding({ projectId: null, effectiveFrom: today, incrementMinutes: rounding.minutes, method: rounding.method as RoundMethod }, today));
        return ok;
      }
      if (id === 'project' && name.trim() !== '' && made.project === null) {
        setTouched(true);
        if (nameError || priceError || !priceResult.ok) return false;
        const input = { name: name.trim(), color: normalizeHex(color) ?? color, billable: true, budgetHours: null, clientZone: null };
        const saved = await api.createProject(input);
        adopt(saved.snapshot);
        if (saved.replacedFrom) notices.report({ kind: 'project', itemId: saved.id, name: input.name, asked: saved.replacedFrom, got: saved.color });
        if (priceResult.cents !== null) adopt(await api.setRate({ projectId: saved.id, rateCents: priceResult.cents, currency }));
        setMade((m) => ({ ...m, project: input.name }));
        return true;
      }
      if (id === 'shifts') {
        for (const p of PRESETS.filter((x) => ticked.includes(x.name) && !made.shifts.includes(x.name))) {
          const saved = await api.saveShift({ shiftId: null, effectiveFrom: today, name: p.name, color: p.color, start: p.start, end: p.end, weekdays: [1, 2, 3, 4, 5], zone: zones.my, breakMinutes: 0 });
          adopt(saved.snapshot);
          setMade((m) => ({ ...m, shifts: [...m.shifts, p.name] }));
        }
      }
      return true;
    } catch (e) {
      setError(errorMessage(e));
      return false;
    }
  }

  async function connect(root: string, provider: 'oneDrive' | 'googleDrive' | 'custom'): Promise<void> {
    setBusy(true);
    try {
      if (!(await act(() => api.addSyncTarget(provider, root)))) return;
      // Bring the other computer's data in now, so the steps it answers are skipped.
      await act(() => api.syncNow());
      go('theme');
    } finally {
      setBusy(false);
    }
  }

  const optional = OPTIONAL_STEPS.includes(current);
  const last = current === 'summary';
  const title = STEP_TITLE[current];

  return (
    <main className="firstrun wizard" aria-labelledby="wizard-title" data-testid="setup-wizard" data-step={current}>
      <div className="firstrun-card wizard-card">
        <p className="wizard-progress" data-testid="wizard-progress">
          Step {position + 1} of {steps.length}
          {optional ? ' (optional)' : ''}
        </p>
        <ol className="wizard-dots" aria-label="Setup steps">
          {steps.map((s, i) => (
            <li key={s} aria-current={s === current ? 'step' : undefined} className={i < position ? 'done' : i === position ? 'now' : ''}>
              <span className="visually-hidden">{`${STEP_TITLE[s]}${i < position ? ', done' : i === position ? ', current step' : ''}`}</span>
            </li>
          ))}
        </ol>
        <h1 id="wizard-title" ref={heading} tabIndex={-1}>
          {title}
        </h1>

        {current === 'welcome' && (
          <div className="wizard-body">
            <p className="lead">Welcome to zWorkTracker. It times your work, one task at a time, and keeps everything on this computer.</p>
            <p>A few quick choices make it yours. Every step has a sensible default, you can skip any of them, and everything can be changed later in Settings. Nothing here logs any time.</p>
            {rerun && <p className="wizard-note">This is the setup again. It only changes a setting when you press Next on its step, and it never touches your projects, tasks or logged time.</p>}
          </div>
        )}

        {current === 'connect' && (
          <div className="wizard-body">
            <p>This looks like your second computer: a folder here already holds zWorkTracker data. Connect it first, and the choices it already holds (zones, rounding, projects, shifts) will not be asked again.</p>
            <ul className="wizard-folders" aria-label="Folders with data">
              {withData.map((d) => {
                const p = previews.get(d.root);
                const v = p && p !== 'error' ? p : null;
                return (
                  <li key={d.root} data-testid="connect-offer">
                    <strong>{folderLabel(d)}</strong>
                    {v && (
                      <p data-testid="connect-counts">
                        {plural(v.projects, 'project')}, {plural(v.tasks, 'task')}, {plural(v.segments, 'time segment')}
                        {v.devices.length > 0 && ` from ${v.devices.join(', ')}`}. Connecting merges it with this computer; nothing is deleted on either side.
                      </p>
                    )}
                    <Button variant="primary" disabled={busy} onClick={() => void connect(d.root, d.provider)}>
                      Connect and bring it in
                    </Button>
                  </li>
                );
              })}
            </ul>
            <p className="field-hint">Not now keeps this computer on its own until you connect in Settings.</p>
          </div>
        )}

        {current === 'theme' && (
          <div className="wizard-body">
            <p>Pick how the app looks. The page changes as you choose. Light is the default.</p>
            <ThemeSection />
          </div>
        )}

        {current === 'zones' && (
          <div className="wizard-body">
            <div className="kv">
              <div>
                <p className="kv-label">My zone</p>
                <p data-testid="wizard-my-zone">{zoneLabel(zones.my, nowSec)}</p>
                <p className="field-hint">{snapshot.settings.myZone ? 'Chosen by you.' : `Detected from this computer (${snapshot.systemZone}). Keep it unless you work in another zone.`}</p>
              </div>
              <Button small onClick={() => setPick('my')}>
                Change my zone
              </Button>
            </div>
            <div className="kv">
              <div>
                <p className="kv-label">Client zone</p>
                <p data-testid="wizard-client-zone">{zones.client ? zoneLabel(zones.client, nowSec) : 'None'}</p>
                <p className="field-hint">Only if you work with a client in another time zone. Nothing is assumed for you.</p>
              </div>
              <div className="inline-actions">
                <Button small onClick={() => setPick('client')}>
                  {zones.client ? 'Change client zone' : 'Choose client zone'}
                </Button>
                {zones.client && (
                  <Button small variant="ghost" onClick={() => void act(() => api.setSetting('clientZone', null))}>
                    No client zone
                  </Button>
                )}
              </div>
            </div>
            <ZonePickerDialog
              open={pick !== null}
              title={pick === 'client' ? 'Client zone' : 'My zone'}
              value={pick === 'client' ? zones.client : zones.my}
              onPick={(z) => {
                const which = pick;
                setPick(null);
                if (which) void act(() => api.setSetting(which === 'client' ? 'clientZone' : 'myZone', z));
              }}
              onClose={() => setPick(null)}
            />
          </div>
        )}

        {current === 'rules' && (
          <div className="wizard-body">
            <p>Billable time is each task's time on one day, rounded once for that day. The default is {incrementLabel(15)}, Up.</p>
            <RoundingFields legend="Rounding" value={rounding} onChange={setRounding} />
            <p data-testid="rule-sentence">{ruleSentence({ incrementMinutes: rounding.minutes, method: rounding.method })}</p>
            <table className="wizard-table" aria-label="What the rule bills">
              <thead>
                <tr>
                  <th scope="col">You work on one task in a day</th>
                  <th scope="col" className="num">
                    Billed as
                  </th>
                </tr>
              </thead>
              <tbody>
                {ruleTable({ incrementMinutes: rounding.minutes, method: rounding.method }).map((r) => (
                  <tr key={r.worked}>
                    <td>{r.worked} min</td>
                    <td className="num tabular">{r.billed} min</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="field-hint">
              {rounding.minutes === 0 ? 'Off' : `${rounding.minutes} min, ${METHOD_LABEL[rounding.method]}`} applies from today on. Past days keep what applied to them.
            </p>
          </div>
        )}

        {current === 'project' && (
          <div className="wizard-body">
            {made.project ? (
              <p role="status" data-testid="project-made">
                Created the project “{made.project}”. Edit it any time in Projects.
              </p>
            ) : (
              <>
                <p>Optional. Name your first project to have it ready; leave the name empty to skip. You can add more in the Projects tab.</p>
                <Field label="Project name" error={touched ? nameError : null}>
                  {({ id, describedBy }) => <input id={id} className="input" value={name} onChange={(e) => setName(e.target.value)} autoComplete="off" aria-describedby={describedBy} aria-invalid={touched && nameError ? true : undefined} />}
                </Field>
                <ColorPicker label="Colour" value={normalizeHex(color) ?? color} onChange={setColor} sampleName={name.trim() || 'Project name'} theme={snapshot.prefs.theme} />
                <div className="row-fields">
                  <Field label="Price per hour" hint="Leave empty for no rate yet." error={touched ? priceError : null}>
                    {({ id, describedBy }) => <input id={id} className="input input-narrow" inputMode="decimal" value={price} onChange={(e) => setPrice(e.target.value)} aria-describedby={describedBy} aria-invalid={touched && priceError ? true : undefined} placeholder="e.g. 60" />}
                  </Field>
                  <Field label="Currency">
                    {({ id }) => (
                      <select id={id} className="input" value={currency} onChange={(e) => setCurrency(e.target.value as Currency)}>
                        <option value="EUR">EUR (€)</option>
                        <option value="USD">USD ($)</option>
                      </select>
                    )}
                  </Field>
                </div>
              </>
            )}
          </div>
        )}

        {current === 'shifts' && (
          <div className="wizard-body">
            <p>Optional. Shifts shade your usual working hours on the Timeline and feed the shift figures in Analysis. Tick the ones you work; they run Monday to Friday in {zoneLabel(zones.my, nowSec)}. You can edit them in Settings.</p>
            <ul className="wizard-presets" aria-label="Shift presets">
              {PRESETS.map((p) => {
                const done = made.shifts.includes(p.name);
                return (
                  <li key={p.name}>
                    <label className="check">
                      <input type="checkbox" checked={done || ticked.includes(p.name)} disabled={done} onChange={(e) => setTicked((t) => (e.target.checked ? [...t, p.name] : t.filter((x) => x !== p.name)))} />
                      <span>
                        {p.name}, {p.start} to {p.end}
                        {done ? ' (added)' : ''}
                      </span>
                    </label>
                  </li>
                );
              })}
            </ul>
          </div>
        )}

        {current === 'sync' && (
          <div className="wizard-body">
            <p>Optional. To use zWorkTracker on two computers, it can write its data into a OneDrive or Google Drive folder. Nothing is switched on unless you tick a folder and connect it.</p>
            <SyncChooser detected={snapshot.sync.detected} existing={snapshot.sync.targets.map((t) => t.root)} onConnected={next} />
          </div>
        )}

        {current === 'autostart' && (
          <div className="wizard-body">
            <p>Off by default. If you turn it on, zWorkTracker starts hidden in the system tray when you sign in. It changes only this computer.</p>
            <AutostartSection />
          </div>
        )}

        {current === 'summary' && (
          <div className="wizard-body">
            <p>This is how things are set. Everything can be changed later in Settings.</p>
            <dl className="kv-list" data-testid="wizard-summary">
              <div>
                <dt>Theme</dt>
                <dd>{THEME_LABELS[snapshot.prefs.theme]}</dd>
              </div>
              <div>
                <dt>My zone</dt>
                <dd>{zoneLabel(zones.my, nowSec)}</dd>
              </div>
              <div>
                <dt>Client zone</dt>
                <dd>{zones.client ? zoneLabel(zones.client, nowSec) : 'None'}</dd>
              </div>
              <div>
                <dt>Rounding</dt>
                <dd>
                  {incrementLabel(rule.incrementMinutes)}
                  {rule.incrementMinutes > 0 && `, ${METHOD_LABEL[rule.method]}`}
                </dd>
              </div>
              <div>
                <dt>Projects</dt>
                <dd>{snapshot.projects.length === 0 ? 'None yet' : snapshot.projects.map((p) => p.name).join(', ')}</dd>
              </div>
              <div>
                <dt>Shifts</dt>
                <dd>{snapshot.shifts.length === 0 ? 'None' : [...new Set(snapshot.shifts.map((s) => s.name))].join(', ')}</dd>
              </div>
              <div>
                <dt>Sync</dt>
                <dd>{snapshot.sync.targets.length === 0 ? 'Off' : snapshot.sync.targets.map((t) => t.root).join(', ')}</dd>
              </div>
            </dl>
          </div>
        )}

        {error && (
          <p className="bl-error" role="alert">
            {error}
          </p>
        )}

        <div className="wizard-actions">
          <div className="wizard-nav">
            {position > 0 && (
              <Button icon={<IconBack />} onClick={back} disabled={busy}>
                Back
              </Button>
            )}
            {!last && current !== 'welcome' && current !== 'sync' && (
              <Button variant="ghost" onClick={next} disabled={busy}>
                {current === 'connect' ? 'Not now' : 'Skip'}
              </Button>
            )}
            {current === 'sync' && (
              <Button variant="ghost" onClick={next} disabled={busy}>
                Skip
              </Button>
            )}
            {last ? (
              <Button variant="primary" onClick={() => void finish()} disabled={busy}>
                Finish
              </Button>
            ) : (
              current !== 'connect' &&
              current !== 'sync' && (
                <Button
                  variant="primary"
                  disabled={busy}
                  onClick={() => {
                    setBusy(true);
                    void save(current)
                      .then((ok) => ok && next())
                      .finally(() => setBusy(false));
                  }}
                >
                  Next
                </Button>
              )
            )}
          </div>
          {!last && (
            <Button variant="secondary" onClick={() => void finish()} disabled={busy} data-testid="finish-defaults">
              {rerun ? 'Exit setup' : 'Finish with defaults'}
            </Button>
          )}
        </div>
        <p className="wizard-foot muted">Nothing you choose here logs any time or changes your data.</p>
      </div>
    </main>
  );
}
