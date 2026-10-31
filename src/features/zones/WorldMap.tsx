// Interactive offline world map: country outlines (SVG), zone highlight masks (canvas, from a lookup
// grid), city pins, pan and zoom. Everything is bundled; there are no tiles and no network.
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';

import { abbrAt, cityOf, clockAt, formatOffset, offsetAt } from '../../lib/tz';
import { CITY_PINS, LAT_MAX, LAT_MIN, resolveZone, WORLD_H, WORLD_W } from './geo';
import { sharedGrid, type ZoneGrid } from './grid';
import { graticulePath, loadCountryPaths, type CountryPath } from './mapData';
import { MaskPainter } from './maskDraw';
import { placePins, type Pin, type PlacedPin, type Size } from './pins';
import { baseScale, clampView, fitView, panBy, screenToGeo, zoomAbout, type View } from './viewport';

import './zones.css';

export interface WorldMapProps {
  /** The zone currently chosen; drawn in the selection colour. */
  selected: string | null;
  /** A zone previewed from the list; drawn like a hover. */
  preview: string | null;
  myZone: string;
  clientZone: string | null;
  /** Instant used for the local time shown while hovering; the caller keeps it to whole minutes. */
  nowSec: number;
  onPick: (zone: string) => void;
  /** Reports the zone under the pointer, or null when the pointer is off the map. */
  onHover: (zone: string | null) => void;
}

const CLICK_SLOP = 4;
const PIN_HIT = 9;
const GRATICULE = graticulePath();

const CountriesLayer = memo(function CountriesLayer({ paths }: { paths: readonly CountryPath[] }) {
  return (
    <>
      {paths.map((p) => (
        <path key={p.id} d={p.d} />
      ))}
    </>
  );
});

function describe(zone: string, sec: number): string {
  if (zone === 'UTC') return 'UTC';
  return `${cityOf(zone)}, ${zone.replaceAll('_', ' ')}, ${abbrAt(sec, zone)} ${formatOffset(offsetAt(sec, zone))}, ${clockAt(sec, zone)} local time`;
}

function WorldMap({ selected, preview, myZone, clientZone, nowSec, onPick, onHover }: WorldMapProps) {
  const frameRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [size, setSize] = useState<Size>({ w: 0, h: 0 });
  const [view, setView] = useState<View>({ k: 1, x: 0, y: 0 });
  const [paths, setPaths] = useState<CountryPath[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [grid, setGrid] = useState<ZoneGrid | null>(null);
  const [hover, setHover] = useState<{ zone: string | null; viaRing: boolean } | null>(null);
  const [dragging, setDragging] = useState(false);
  const [themeTick, setThemeTick] = useState(0);
  const drag = useRef<{ id: number; sx: number; sy: number; view: View; moved: boolean } | null>(null);
  const sizeRef = useRef(size);
  const viewRef = useRef(view);
  useLayoutEffect(() => {
    sizeRef.current = size;
    viewRef.current = view;
  }, [size, view]);
  const painter = useRef<MaskPainter | null>(null);

  useEffect(() => {
    let alive = true;
    loadCountryPaths().then(
      (p) => alive && setPaths(p),
      (e: unknown) => alive && setLoadError(e instanceof Error ? e.message : String(e)),
    );
    sharedGrid().then(
      (g) => alive && setGrid(g),
      () => undefined,
    );
    return () => {
      alive = false;
    };
  }, []);

  useLayoutEffect(() => {
    const el = frameRef.current;
    if (!el) return;
    const measure = () => {
      const w = el.clientWidth;
      const h = el.clientHeight;
      setSize((s) => (s.w === w && s.h === h ? s : { w, h }));
      setView((v) => (v.k === 1 && v.x === 0 && v.y === 0 ? fitView(w, h) : clampView(v, w, h)));
    };
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Theme changes recolour the canvas masks; the SVG follows the CSS variables on its own.
  useEffect(() => {
    const mo = new MutationObserver(() => {
      setThemeTick((t) => t + 1);
    });
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    return () => mo.disconnect();
  }, []);

  // Wheel zoom needs a non-passive listener to stop the page from scrolling.
  useEffect(() => {
    const el = frameRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const rect = el.getBoundingClientRect();
      const unit = e.deltaMode === 1 ? 16 : 1;
      const factor = Math.exp((-e.deltaY * unit) / 400);
      const { w, h } = sizeRef.current;
      setView((v) => zoomAbout(v, factor, e.clientX - rect.left, e.clientY - rect.top, w, h));
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);

  const highlight = hover?.zone ?? preview;

  useEffect(() => {
    onHover(hover?.zone ?? null);
  }, [hover?.zone, onHover]);

  const land = useMemo(() => {
    if (!paths || typeof Path2D === 'undefined') return null;
    return new Path2D(paths.map((p) => p.d).join(''));
  }, [paths]);

  // Highlight masks: the chosen zone and the hovered or previewed one.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || size.w === 0 || size.h === 0) return;
    painter.current ??= new MaskPainter();
    const css = getComputedStyle(canvas);
    const color = (token: string, fallback: string) => css.getPropertyValue(token).trim() || fallback;
    const started = performance.now();
    painter.current.paint({
      canvas,
      size,
      dpr: window.devicePixelRatio || 1,
      view,
      land,
      masks: [
        { zone: selected, color: color('--map-selected', '#0f766e'), landAlpha: 0.6, seaAlpha: 0.2 },
        { zone: highlight && highlight !== selected ? highlight : null, color: color('--map-highlight', '#f59e0b'), landAlpha: 0.55, seaAlpha: 0.18 },
      ],
    });
    canvas.dataset.paintMs = (performance.now() - started).toFixed(1);
  }, [land, size, view, selected, highlight, themeTick]);

  const pins = useMemo<Pin[]>(() => {
    const out: Pin[] = [];
    const locate = (zone: string): { lat: number; lon: number } | null => {
      const city = CITY_PINS.find((p) => p.zone === zone);
      return city ?? grid?.anchor(zone) ?? null;
    };
    const mine = locate(myZone);
    const client = clientZone ? locate(clientZone) : null;
    if (mine) out.push({ key: 'mine', kind: 'mine', zone: myZone, label: `My zone: ${cityOf(myZone)}`, ...mine });
    if (client && clientZone) {
      out.push({ key: 'client', kind: 'client', zone: clientZone, label: `Client: ${cityOf(clientZone)}`, ...client });
    }
    for (const c of CITY_PINS) {
      if (c.zone === myZone || c.zone === clientZone) continue;
      out.push({ key: c.name, kind: 'city', zone: c.zone, label: c.name, lat: c.lat, lon: c.lon });
    }
    return out;
  }, [grid, myZone, clientZone]);

  const placed = useMemo(() => (size.w ? placePins(pins, view, size) : []), [pins, view, size]);

  const localPoint = useCallback((e: { clientX: number; clientY: number }) => {
    const rect = frameRef.current?.getBoundingClientRect();
    return { x: e.clientX - (rect?.left ?? 0), y: e.clientY - (rect?.top ?? 0) };
  }, []);

  const probe = useCallback(
    (x: number, y: number): { zone: string | null; viaRing: boolean } | null => {
      const { lat, lon } = screenToGeo(viewRef.current, sizeRef.current.w, x, y);
      if (lat > LAT_MAX || lat < LAT_MIN || lon < -180 || lon > 180) return null;
      const r = resolveZone(lat, lon);
      return { zone: r?.zone ?? null, viaRing: r?.viaRing ?? false };
    },
    [],
  );

  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    const p = localPoint(e);
    drag.current = { id: e.pointerId, sx: p.x, sy: p.y, view: viewRef.current, moved: false };
    e.currentTarget.setPointerCapture(e.pointerId);
  };

  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    const p = localPoint(e);
    const d = drag.current;
    if (d && d.id === e.pointerId) {
      const dx = p.x - d.sx;
      const dy = p.y - d.sy;
      if (!d.moved && Math.hypot(dx, dy) > CLICK_SLOP) {
        d.moved = true;
        setDragging(true);
        setHover(null);
      }
      if (d.moved) setView(panBy(d.view, dx, dy, sizeRef.current.w, sizeRef.current.h));
      return;
    }
    const next = probe(p.x, p.y);
    setHover((prev) => (prev?.zone === next?.zone && prev?.viaRing === next?.viaRing ? prev : next));
  };

  const onPointerUp = (e: PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    drag.current = null;
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
    setDragging(false);
    if (!d || d.moved) return;
    const p = localPoint(e);
    let nearest: PlacedPin | null = null;
    let nearestD = PIN_HIT;
    for (const pin of placed) {
      const dist = Math.hypot(pin.x - p.x, pin.y - p.y);
      if (dist <= nearestD) {
        nearest = pin;
        nearestD = dist;
      }
    }
    if (nearest) {
      onPick(nearest.zone);
      return;
    }
    const hit = probe(p.x, p.y);
    if (hit?.zone) onPick(hit.zone);
  };

  const onPointerLeave = () => {
    if (!drag.current) setHover(null);
  };

  const zoomBy = (factor: number) => setView((v) => zoomAbout(v, factor, size.w / 2, size.h / 2, size.w, size.h));

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const step = e.shiftKey ? 240 : 80;
    const pan = (dx: number, dy: number) => {
      e.preventDefault();
      setView((v) => panBy(v, dx, dy, size.w, size.h));
    };
    switch (e.key) {
      case 'ArrowLeft': return pan(step, 0);
      case 'ArrowRight': return pan(-step, 0);
      case 'ArrowUp': return pan(0, step);
      case 'ArrowDown': return pan(0, -step);
      case '+':
      case '=':
        e.preventDefault();
        return zoomBy(1.5);
      case '-':
      case '_':
        e.preventDefault();
        return zoomBy(1 / 1.5);
      case '0':
        e.preventDefault();
        return setView(fitView(size.w, size.h));
      default:
    }
  };

  const scale = baseScale(size.w) * view.k;
  const label = selected
    ? `World map. Selected time zone: ${describe(selected, nowSec)}. Arrow keys pan, plus and minus zoom, zero resets. The zone list is the keyboard way to choose.`
    : 'World map. No time zone selected. Arrow keys pan, plus and minus zoom, zero resets. The zone list is the keyboard way to choose.';

  const info = hover
    ? hover.zone
      ? `${hover.viaRing ? 'Nearest zone: ' : ''}${describe(hover.zone, nowSec)}`
      : 'No time zone found near this point'
    : selected
      ? `Selected: ${describe(selected, nowSec)}`
      : 'Hover over the map to see a zone, click to choose it';

  return (
    <div className="zn-map-wrap">
      <div
        ref={frameRef}
        className={`zn-map${dragging ? ' zn-map-dragging' : ''}`}
        role="application"
        aria-label={label}
        tabIndex={0}
        data-testid="zone-map"
        data-zoom={view.k.toFixed(2)}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onPointerLeave={onPointerLeave}
        onKeyDown={onKeyDown}
      >
        {size.w > 0 && (
          <svg className="zn-map-svg" width={size.w} height={size.h} aria-hidden="true" focusable="false">
            <g transform={`translate(${view.x} ${view.y}) scale(${scale})`}>
              <rect className="zn-ocean" x={0} y={0} width={WORLD_W} height={WORLD_H} />
              <path className="zn-graticule" d={GRATICULE} />
              <g className="zn-countries" data-testid="zone-map-countries">
                {paths && <CountriesLayer paths={paths} />}
              </g>
            </g>
          </svg>
        )}
        <canvas ref={canvasRef} className="zn-map-canvas" aria-hidden="true" />
        {size.w > 0 && (
          <svg className="zn-map-svg zn-pins" width={size.w} height={size.h} aria-hidden="true" focusable="false">
            {placed.map((p) => (
              <g key={p.key} transform={`translate(${p.x} ${p.y})`} data-pin={p.key}>
                {p.kind === 'city' && <circle className="zn-pin-city" r={3.6} />}
                {p.kind === 'mine' && <circle className="zn-pin-mine" r={6.5} />}
                {p.kind === 'client' && <rect className="zn-pin-client" x={-5.5} y={-5.5} width={11} height={11} transform="rotate(45)" />}
                {p.labelAt && (
                  <text
                    className={`zn-pin-label${p.kind === 'city' ? '' : ' zn-pin-label-strong'}`}
                    x={p.labelAt.x - p.x}
                    y={4}
                    textAnchor={p.labelAt.anchor}
                  >
                    {p.label}
                  </text>
                )}
              </g>
            ))}
          </svg>
        )}
        {!paths && !loadError && <p className="zn-map-status">Loading map…</p>}
        {loadError && <p className="zn-map-status zn-map-error">The map could not be drawn ({loadError}). The zone list still works.</p>}
        <p className="zn-map-info" aria-hidden="true" data-testid="zone-map-info">
          {info}
        </p>
      </div>
      <div className="zn-map-controls">
        <button type="button" aria-label="Zoom in" title="Zoom in" onClick={() => zoomBy(1.5)}>
          +
        </button>
        <button type="button" aria-label="Zoom out" title="Zoom out" onClick={() => zoomBy(1 / 1.5)}>
          −
        </button>
        <button type="button" aria-label="Reset map view" title="Reset map view" onClick={() => setView(fitView(size.w, size.h))}>
          ⌂
        </button>
      </div>
    </div>
  );
}

export default memo(WorldMap);
