import { lazy, memo, Suspense, useCallback, useEffect, useId, useMemo, useRef, useState, type ChangeEvent, type KeyboardEvent } from 'react';

import { useApp } from '../../app/store';
import { cityOf, zoneLabel } from '../../lib/tz';
import { gapNotice, clockChangeLines } from './notices';
import { buildRows, filterRows, listedZones, type ZoneRow } from './zoneData';

import './zones.css';

// The map and its country data load only when the picker opens.
const WorldMap = lazy(() => import('./WorldMap'));

export interface ZonePickerProps {
  open: boolean;
  title: string;
  value: string | null;
  /** Called with the chosen zone, from the list or the map. The dialog then calls `onClose`. */
  onPick: (zone: string) => void;
  onClose: () => void;
}

export function ZonePickerDialog(props: ZonePickerProps) {
  if (!props.open) return null;
  return <PickerBody {...props} />;
}

interface OptionProps {
  row: ZoneRow;
  id: string;
  active: boolean;
  chosen: boolean;
  tags: string[];
  onChoose: (zone: string) => void;
  onActivate: (zone: string) => void;
}

const Option = memo(function Option({ row, id, active, chosen, tags, onChoose, onActivate }: OptionProps) {
  return (
    <li
      id={id}
      role="option"
      aria-selected={chosen}
      data-zone={row.zone}
      className={`zn-opt${active ? ' zn-opt-active' : ''}${chosen ? ' zn-opt-chosen' : ''}`}
      onClick={() => onChoose(row.zone)}
      onMouseMove={() => !active && onActivate(row.zone)}
    >
      <span className="zn-opt-main">
        <span className="zn-opt-city">{row.zone === 'UTC' ? 'UTC' : row.city}</span>
        {tags.map((t) => (
          <span key={t} className="zn-tag">
            {t}
          </span>
        ))}
        <span className="zn-opt-time tabular">{row.clock}</span>
      </span>
      <span className="zn-opt-sub">
        <span>{row.zone === 'UTC' ? 'Coordinated Universal Time' : row.path}</span>
        <span className="tabular">{row.zone === 'UTC' ? 'UTC+0' : `${row.abbr} · ${row.offsetText}`}</span>
      </span>
    </li>
  );
});

function PickerBody({ title, value, onPick, onClose }: ZonePickerProps) {
  const { zones, nowSec } = useApp();
  const minuteSec = Math.floor(nowSec / 60) * 60;
  const dialogRef = useRef<HTMLDialogElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const uid = useId();
  const titleId = `${uid}-title`;
  const listId = `${uid}-list`;

  const rows = useMemo(() => {
    const zs = new Set(listedZones());
    for (const z of [value, zones.my, zones.client]) if (z) zs.add(z);
    return buildRows([...zs], minuteSec).sort((a, b) => a.city.localeCompare(b.city) || a.zone.localeCompare(b.zone));
  }, [value, zones.my, zones.client, minuteSec]);

  const [query, setQuery] = useState('');
  const filtered = useMemo(() => filterRows(rows, query), [rows, query]);
  const [activeZone, setActiveZone] = useState<string | null>(value);
  const [mapHover, setMapHover] = useState<string | null>(null);

  const activeIndex = Math.max(0, filtered.findIndex((r) => r.zone === activeZone));
  const activeRow = filtered[activeIndex];

  useEffect(() => {
    const el = dialogRef.current;
    if (!el) return;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    if (typeof el.showModal === 'function') {
      if (!el.open) el.showModal();
    } else {
      el.setAttribute('open', '');
    }
    searchRef.current?.focus();
    return () => {
      if (el.open && typeof el.close === 'function') el.close();
      previous?.focus();
    };
  }, []);

  useEffect(() => {
    listRef.current?.querySelector('.zn-opt-active')?.scrollIntoView?.({ block: 'nearest' });
  }, [activeZone, query]);

  const choose = useCallback(
    (zone: string) => {
      onPick(zone);
      onClose();
    },
    [onPick, onClose],
  );

  const onSearch = (e: ChangeEvent<HTMLInputElement>) => {
    setQuery(e.target.value);
    setActiveZone(filterRows(rows, e.target.value)[0]?.zone ?? null);
  };

  const onSearchKey = (e: KeyboardEvent<HTMLInputElement>) => {
    const move = (delta: number) => {
      e.preventDefault();
      if (filtered.length === 0) return;
      const next = Math.min(filtered.length - 1, Math.max(0, activeIndex + delta));
      setActiveZone(filtered[next]?.zone ?? null);
    };
    switch (e.key) {
      case 'ArrowDown': return move(1);
      case 'ArrowUp': return move(-1);
      case 'PageDown': return move(8);
      case 'PageUp': return move(-8);
      case 'Enter':
        e.preventDefault();
        if (activeRow) choose(activeRow.zone);
        return;
      default:
    }
  };

  const tagsFor = useCallback(
    (zone: string): string[] => {
      const t: string[] = [];
      if (zone === zones.my) t.push('My zone');
      if (zone === zones.client) t.push('Client zone');
      return t;
    },
    [zones.my, zones.client],
  );

  const previewZone = activeRow?.zone ?? null;
  const candidate = mapHover ?? previewZone ?? value;

  const clockLines = useMemo(() => {
    const entries: { zone: string; role: string }[] = [];
    if (candidate) entries.push({ zone: candidate, role: 'Highlighted' });
    entries.push({ zone: zones.my, role: 'My zone' });
    if (zones.client) entries.push({ zone: zones.client, role: 'Client zone' });
    return clockChangeLines(entries, minuteSec);
  }, [candidate, zones.my, zones.client, minuteSec]);

  const gaps = useMemo(() => {
    const out = [];
    if (candidate && candidate !== zones.my) out.push(gapNotice(zones.my, candidate, minuteSec));
    if (zones.client && zones.client !== zones.my && zones.client !== candidate) out.push(gapNotice(zones.my, zones.client, minuteSec));
    return out.filter((g) => g !== null);
  }, [candidate, zones.my, zones.client, minuteSec]);

  return (
    <dialog
      ref={dialogRef}
      className="zn-dialog"
      aria-labelledby={titleId}
      data-testid="zone-picker"
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="zn-dialog-inner">
        <header className="zn-dialog-head">
          <h2 id={titleId}>{title}</h2>
          <button type="button" className="zn-close" aria-label="Close" onClick={onClose}>
            ×
          </button>
        </header>
        <div className="zn-dialog-body">
          <section className="zn-list-pane" aria-label="Choose from the list">
            <label className="zn-search-label" htmlFor={`${uid}-search`}>
              Search by city, zone name or offset
            </label>
            <input
              id={`${uid}-search`}
              ref={searchRef}
              className="zn-search"
              type="text"
              role="combobox"
              aria-expanded="true"
              aria-controls={listId}
              aria-autocomplete="list"
              aria-activedescendant={activeRow ? `${uid}-opt-${activeRow.zone}` : undefined}
              autoComplete="off"
              spellCheck={false}
              placeholder="Lisbon, America/Chicago, UTC+5:30, EST"
              value={query}
              onChange={onSearch}
              onKeyDown={onSearchKey}
              data-testid="zone-search"
            />
            <p className="zn-count muted" aria-live="polite">
              {filtered.length === 1 ? '1 zone' : `${filtered.length} zones`}
              {query ? ' match' : ''}
            </p>
            <ul id={listId} ref={listRef} className="zn-list" role="listbox" aria-label="Time zones">
              {filtered.map((row) => (
                <Option
                  key={row.zone}
                  row={row}
                  id={`${uid}-opt-${row.zone}`}
                  active={row.zone === activeRow?.zone}
                  chosen={row.zone === value}
                  tags={tagsFor(row.zone)}
                  onChoose={choose}
                  onActivate={setActiveZone}
                />
              ))}
            </ul>
            {filtered.length === 0 && <p className="zn-empty">No zone matches “{query}”. Try a city, a region such as Europe, or an offset such as UTC-4.</p>}
          </section>
          <section className="zn-map-pane" aria-label="Choose on the map">
            <Suspense fallback={<p className="zn-map-status">Loading map…</p>}>
              <WorldMap
                selected={value}
                preview={previewZone}
                myZone={zones.my}
                clientZone={zones.client}
                nowSec={minuteSec}
                onPick={choose}
                onHover={setMapHover}
              />
            </Suspense>
            <ul className="zn-legend" aria-label="Map key">
              <li>
                <span className="zn-key zn-key-selected" aria-hidden="true" /> Chosen zone{value ? `: ${cityOf(value)}` : ''}
              </li>
              <li>
                <span className="zn-key zn-key-hover" aria-hidden="true" /> Zone under the pointer or highlighted in the list
              </li>
              <li>
                <svg className="zn-key-pin" width="14" height="14" viewBox="-7 -7 14 14" aria-hidden="true">
                  <circle className="zn-pin-mine" r={5.5} />
                </svg>{' '}
                My zone
              </li>
              <li>
                <svg className="zn-key-pin" width="14" height="14" viewBox="-7 -7 14 14" aria-hidden="true">
                  <rect className="zn-pin-client" x={-4.5} y={-4.5} width={9} height={9} transform="rotate(45)" />
                </svg>{' '}
                Client zone
              </li>
            </ul>
            <div className="zn-notices" data-testid="zone-notices">
              <h3>Clock changes</h3>
              <ul>
                {clockLines.map((l) => (
                  <li key={l.zone}>
                    <strong>{l.roles.join(', ')}</strong> · {zoneLabel(l.zone, minuteSec)}
                    <br />
                    <span className={l.hasChange ? '' : 'muted'}>{l.text}</span>
                  </li>
                ))}
              </ul>
              {gaps.map((g) => (
                <p key={`${g.a}|${g.b}`} className="zn-gap">
                  <strong>Time difference now:</strong> {g.now}.
                  {g.changes.length > 0 && (
                    <>
                      {' '}
                      It changes during the next year because the two places change clocks on different dates:
                      <span className="zn-gap-list">
                        {g.changes.map((c) => (
                          <span key={c}>{c}</span>
                        ))}
                      </span>
                    </>
                  )}
                </p>
              ))}
            </div>
          </section>
        </div>
      </div>
    </dialog>
  );
}
