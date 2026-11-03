import { useState } from 'react';

import { useApp } from '../../app/store';
import { useReadOnly } from '../../app/useReadOnly';
import { api } from '../../lib/api';
import { PROJECT_PALETTE } from '../../lib/color';
import { cityOf, dayOf, zoneLabel } from '../../lib/tz';
import type { ShiftVersion } from '../../lib/types';
import { useDirtyGuard } from '../../components/dirtyGuard';
import { WEEKDAY_NAMES } from '../../components/format';
import { Badge, Button, ConfirmDialog, Field, Swatch, onRadioKeyDown } from '../../components/ui';
import { IconPlus } from '../../components/icons';
import { useCommands } from '../../components/useCommands';
import { ZonePickerDialog } from '../zones';
import { ReadOnlyNote } from './ReadOnlyNote';
import { PRESETS, WEEKDAYS_ALL, checkShift, runsOvernight, shiftGroups, summary, type ShiftDraft } from './shiftLogic';

/** Whether a draft differs from the one the form opened with. The order the weekdays were ticked in is not a difference. */
function changed(d: ShiftDraft, was: ShiftDraft): boolean {
  const days = (v: ShiftDraft): string => [...v.weekdays].sort().join();
  return d.name !== was.name || d.color.toLowerCase() !== was.color.toLowerCase() || d.start !== was.start || d.end !== was.end || d.zone !== was.zone || d.breakMinutes !== was.breakMinutes || d.effectiveFrom !== was.effectiveFrom || days(d) !== days(was);
}

function ShiftForm({ initial, onDone }: { initial: ShiftDraft; onDone: () => void }) {
  const { zones, nowSec } = useApp();
  const { act } = useCommands();
  const { readOnly } = useReadOnly();
  const [d, setD] = useState(initial);
  // Leaving the tab asks first only if something differs from what the form opened with.
  useDirtyGuard(changed(d, initial));
  const [touched, setTouched] = useState(false);
  const [pick, setPick] = useState(false);
  const check = checkShift(d);
  const errors = check.ok ? {} : check.errors;
  const set = <K extends keyof ShiftDraft>(k: K, v: ShiftDraft[K]) => setD((x) => ({ ...x, [k]: v }));
  const zoneKind = d.zone === zones.my ? 'my' : zones.client && d.zone === zones.client ? 'client' : 'other';

  return (
    <form
      className="shift-form"
      aria-label={d.shiftId ? `Edit shift ${initial.name}` : 'New shift'}
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        setTouched(true);
        if (!check.ok || readOnly) return;
        void act(async () => (await api.saveShift(check.input)).snapshot).then((ok) => ok && onDone());
      }}
    >
      <div className="form-grid">
        <Field label="Shift name" error={touched ? errors.name : null}>
          {({ id, describedBy }) => <input id={id} className="input" value={d.name} onChange={(e) => set('name', e.target.value)} aria-describedby={describedBy} aria-required="true" data-autofocus />}
        </Field>
        <div className="field">
          <span className="field-label" id="shift-colour">
            Colour
          </span>
          <div className="swatches" role="radiogroup" aria-labelledby="shift-colour" onKeyDown={onRadioKeyDown}>
            {PROJECT_PALETTE.map((c, i) => (
              <button key={c} type="button" role="radio" aria-checked={d.color.toLowerCase() === c} tabIndex={d.color.toLowerCase() === c || (i === 0 && !(PROJECT_PALETTE as readonly string[]).includes(d.color.toLowerCase())) ? 0 : -1} aria-label={`Colour ${c}`} className={`swatch-btn ${d.color.toLowerCase() === c ? 'on' : ''}`} style={{ background: c }} onClick={() => set('color', c)} />
            ))}
          </div>
        </div>
      </div>
      <div className="row-fields">
        <Field label="Starts" error={touched ? errors.time : null}>
          {({ id, describedBy }) => <input id={id} className="input" type="time" value={d.start} onChange={(e) => set('start', e.target.value)} aria-describedby={describedBy} />}
        </Field>
        <Field label="Ends" hint={runsOvernight(d.start, d.end) ? 'Ends the next day. The shift belongs to the date it starts on.' : undefined}>
          {({ id, describedBy }) => <input id={id} className="input" type="time" value={d.end} onChange={(e) => set('end', e.target.value)} aria-describedby={describedBy} />}
        </Field>
        <Field label="Break (minutes)" error={touched ? errors.break : null}>
          {({ id, describedBy }) => <input id={id} className="input input-narrow" inputMode="numeric" value={d.breakMinutes} onChange={(e) => set('breakMinutes', e.target.value)} aria-describedby={describedBy} />}
        </Field>
      </div>
      <fieldset className="fieldset">
        <legend>Weekdays (the date the shift starts on)</legend>
        <div className="weekday-row">
          {WEEKDAYS_ALL.map((n) => {
            const on = d.weekdays.includes(n);
            return (
              <button key={n} type="button" aria-pressed={on} className={`day-toggle ${on ? 'on' : ''}`} onClick={() => set('weekdays', on ? d.weekdays.filter((x) => x !== n) : [...d.weekdays, n])}>
                {(WEEKDAY_NAMES[n - 1] as string).slice(0, 3)}
                <span className="visually-hidden">{(WEEKDAY_NAMES[n - 1] as string).slice(3)}</span>
              </button>
            );
          })}
        </div>
        {touched && errors.weekdays && (
          <p className="field-error" role="alert">
            {errors.weekdays}
          </p>
        )}
      </fieldset>
      <fieldset className="fieldset">
        <legend>Zone the shift's clock follows</legend>
        <div className="row-fields">
          <label className="check">
            <input type="radio" name="shift-zone" checked={zoneKind === 'my'} onChange={() => set('zone', zones.my)} /> My zone ({cityOf(zones.my)})
          </label>
          {zones.client && (
            <label className="check">
              <input type="radio" name="shift-zone" checked={zoneKind === 'client'} onChange={() => set('zone', zones.client as string)} /> Client zone ({cityOf(zones.client)})
            </label>
          )}
          <label className="check">
            <input type="radio" name="shift-zone" checked={zoneKind === 'other'} onChange={() => setPick(true)} /> Another zone{zoneKind === 'other' ? ` (${cityOf(d.zone)})` : '…'}
          </label>
        </div>
        <p className="field-hint">A shift follows its zone's wall clock through daylight saving, so its length can be an hour more or less on a change day. Now: {zoneLabel(d.zone, nowSec)}.</p>
      </fieldset>
      <Field label="Effective from" hint="Earlier dates keep the version that applied then. Pick today to change the shift from now on.">
        {({ id, describedBy }) => <input id={id} className="input" type="date" value={d.effectiveFrom} onChange={(e) => e.target.value && set('effectiveFrom', e.target.value)} aria-describedby={describedBy} />}
      </Field>
      <div className="form-actions">
        <Button variant="primary" type="submit" disabled={readOnly}>
          Save shift
        </Button>
        <Button variant="ghost" onClick={onDone}>
          Cancel
        </Button>
      </div>
      <ZonePickerDialog open={pick} title="Zone for this shift" value={d.zone} onPick={(z) => { set('zone', z); setPick(false); }} onClose={() => setPick(false)} />
    </form>
  );
}

export function ShiftsSection() {
  const { snapshot, nowSec, zones } = useApp();
  const { act } = useCommands();
  const { readOnly } = useReadOnly();
  const today = dayOf(nowSec, zones.active);
  const [form, setForm] = useState<ShiftDraft | null>(null);
  const [formKey, setFormKey] = useState(0);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [reverting, setReverting] = useState<{ version: ShiftVersion; before: ShiftVersion | null; name: string } | null>(null);
  const groups = shiftGroups(snapshot.shifts, today);

  const blank = (over: Partial<ShiftDraft> = {}): ShiftDraft => ({
    shiftId: null,
    name: '',
    color: PROJECT_PALETTE[0],
    start: '09:00',
    end: '17:00',
    weekdays: [1, 2, 3, 4, 5],
    zone: zones.my,
    breakMinutes: '30',
    effectiveFrom: today,
    ...over,
  });
  const open = (d: ShiftDraft) => {
    setForm(d);
    setFormKey((k) => k + 1);
  };
  const edit = (v: ShiftVersion) =>
    open({ shiftId: v.shiftId, name: v.name, color: v.color, start: v.start, end: v.end, weekdays: [...v.weekdays], zone: v.zone, breakMinutes: String(v.breakMinutes), effectiveFrom: today });

  const setRetired = (v: ShiftVersion, retired: boolean) =>
    void act(async () => (await api.saveShift({ shiftId: v.shiftId, effectiveFrom: today, name: v.name, color: v.color, start: v.start, end: v.end, weekdays: v.weekdays, zone: v.zone, breakMinutes: v.breakMinutes, retired })).snapshot);

  return (
    <div className="settings-stack">
      <ReadOnlyNote />
      <p>Shifts draw as shaded bands on the timeline and feed the shift analysis. Overlapping shifts never count time twice: each moment goes to the shift that started first.</p>
      <div className="inline-actions" role="group" aria-label="Add a shift">
        <Button icon={<IconPlus />} disabled={readOnly} onClick={() => open(blank())}>
          New shift
        </Button>
        {PRESETS.map((p) => (
          <Button key={p.name} small disabled={readOnly} onClick={() => open(blank({ name: p.name, start: p.start, end: p.end, color: p.color }))}>
            Add {p.name} preset
          </Button>
        ))}
      </div>
      {form && <ShiftForm key={formKey} initial={form} onDone={() => setForm(null)} />}
      {groups.length === 0 && !form && <p className="muted">No shifts yet. Presets fill in sensible hours that you can edit before saving.</p>}
      <ul className="shift-list">
        {groups.map((g) => (
          <li key={g.shiftId} className="shift-item">
            <div className="shift-line">
              <Swatch color={g.current.color} />
              <div className="shift-title">
                <h4>
                  {g.current.name} {g.retired && <Badge tone="warning">Retired</Badge>}
                </h4>
                <p className="muted">{summary(g.current)}</p>
              </div>
              <div className="project-actions">
                <Button small disabled={readOnly} onClick={() => edit(g.current)}>
                  Edit <span className="visually-hidden">{g.current.name}</span>
                </Button>
                {g.retired ? (
                  <Button small disabled={readOnly} onClick={() => setRetired(g.current, false)}>
                    Reactivate <span className="visually-hidden">{g.current.name}</span>
                  </Button>
                ) : (
                  <Button small disabled={readOnly} onClick={() => setRetired(g.current, true)}>
                    Retire <span className="visually-hidden">{g.current.name}</span>
                  </Button>
                )}
                <Button small variant="danger" disabled={readOnly} onClick={() => setDeleting(g.shiftId)}>
                  Delete <span className="visually-hidden">{g.current.name}</span>
                </Button>
              </div>
            </div>
            {g.versions.length > 1 && (
              <details className="versions">
                <summary>{g.versions.length} versions</summary>
                <ul className="plain-list">
                  {[...g.versions]
                    .sort((a, b) => a.effectiveFrom.localeCompare(b.effectiveFrom))
                    .map((v, i, sorted) => (
                      <li key={v.id} className="version-row">
                        <span>
                          From <strong>{v.effectiveFrom}</strong>: {v.retired ? 'retired' : summary(v)}
                        </span>
                        <Button small disabled={readOnly} onClick={() => setReverting({ version: v, before: sorted[i - 1] ?? null, name: g.current.name })}>
                          Revert this version <span className="visually-hidden">of {g.current.name} from {v.effectiveFrom}</span>
                        </Button>
                      </li>
                    ))}
                </ul>
              </details>
            )}
          </li>
        ))}
      </ul>
      <ConfirmDialog
        open={reverting !== null}
        title="Revert this version?"
        confirmLabel="Revert version"
        onCancel={() => setReverting(null)}
        onConfirm={() => {
          const v = reverting?.version;
          setReverting(null);
          if (v) void act(() => api.revertShiftVersion(v.id));
        }}
      >
        {reverting && (
          <>
            <p>
              This removes the version of {reverting.name} that starts on {reverting.version.effectiveFrom}.{' '}
              {reverting.before ? `From then on the earlier version applies again: ${reverting.before.retired ? 'retired' : summary(reverting.before)}.` : 'It is the first version, so days before the next version have no band for this shift.'}
            </p>
            <p>The other versions and your logged time are not touched.</p>
          </>
        )}
      </ConfirmDialog>
      <ConfirmDialog
        open={deleting !== null}
        title="Delete this shift?"
        confirmLabel="Delete shift"
        danger
        onCancel={() => setDeleting(null)}
        onConfirm={() => {
          const id = deleting;
          setDeleting(null);
          if (id) void act(() => api.deleteShift(id));
        }}
      >
        <p>This removes every version of the shift, so past days lose its band. Retire it instead to keep the history. Logged time is not affected.</p>
      </ConfirmDialog>
    </div>
  );
}
