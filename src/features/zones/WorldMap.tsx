// Interactive offline world map: country outlines (SVG), zone highlight masks (canvas, from a lookup
// grid), city pins, pan and zoom. Everything is bundled; there are no tiles and no network.
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';

import { abbrAt, cityOf, clockAt, formatOffset, offsetAt } from '../../lib/tz';
import { CITY_PINS, LAT_MAX, LAT_MIN, resolveZone, UNITS_PER_DEG, WORLD_H, WORLD_W } from './geo';
import { GRID_NX, GRID_NY, GRID_STEP, sharedGrid, type ZoneGrid } from './grid';
import { graticulePath, loadCountryPaths, type CountryPath } from './mapData';
import { baseScale, clampView, fitView, geoToScreen, panBy, screenToGeo, zoomAbout, type View } from './viewport';

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

interface Size {
  w: number;
  h: number;
}

type PinKind = 'city' | 'mine' | 'client';
interface Pin {
  key: string;
  kind: PinKind;
  zone: string;
  label: string;
  lat: number;
  lon: number;
}
interface PlacedPin extends Pin {
  x: number;
  y: number;
  /** Where the label goes relative to the pin; null when it would collide with another label. */
  labelAt: { x: number; anchor: 'start' | 'end' } | null;
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

function placePins(pins: readonly Pin[], view: View, size: Size): PlacedPin[] {
  const taken: { x0: number; y0: number; x1: number; y1: number }[] = [];
  const overlaps = (r: { x0: number; y0: number; x1: number; y1: number }): boolean =>
    taken.some((t) => r.x0 < t.x1 && r.x1 > t.x0 && r.y0 < t.y1 && r.y1 > t.y0);
  const placed: PlacedPin[] = [];
  for (const pin of pins) {
    const { x, y } = geoToScreen(view, size.w, pin.lat, pin.lon);
    if (x < -20 || y < -20 || x > size.w + 20 || y > size.h + 20) continue;
    const marker = { x0: x - 7, y0: y - 7, x1: x + 7, y1: y + 7 };
    const textW = pin.label.length * 6.3 + 8;
    const right = { x0: x + 9, y0: y - 8, x1: x + 9 + textW, y1: y + 8 };
    const left = { x0: x - 9 - textW, y0: y - 8, x1: x - 9, y1: y + 8 };
    let labelAt: PlacedPin['labelAt'] = null;
    if (right.x1 <= size.w - 2 && !overlaps(right)) labelAt = { x: x + 10, anchor: 'start' };
    else if (left.x0 >= 2 && !overlaps(left)) labelAt = { x: x - 10, anchor: 'end' };
    taken.push(marker);
    if (labelAt) taken.push(labelAt.anchor === 'start' ? right : left);
    placed.push({ ...pin, x, y, labelAt });
  }
  return placed;
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
  const layers = useRef(new Map<string, HTMLCanvasElement>());

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
      layers.current.clear();
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

  // Highlight masks: the selected zone and the hovered or previewed one, from the lookup grid.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || size.w === 0 || size.h === 0) return;
    const dpr = window.devicePixelRatio || 1;
    const pw = Math.round(size.w * dpr);
    const ph = Math.round(size.h * dpr);
    if (canvas.width !== pw) canvas.width = pw;
    if (canvas.height !== ph) canvas.height = ph;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, size.w, size.h);
    if (!grid) return;
    const css = getComputedStyle(canvas);
    const layerFor = (zone: string, color: string): HTMLCanvasElement | null => {
      const key = `${zone}|${color}`;
      const hit = layers.current.get(key);
      if (hit) return hit;
      const mask = grid.maskFor(zone);
      if (!mask) return null;
      const off = document.createElement('canvas');
      off.width = GRID_NX;
      off.height = GRID_NY;
      const octx = off.getContext('2d');
      if (!octx) return null;
      octx.putImageData(new ImageData(mask, GRID_NX, GRID_NY), 0, 0);
      octx.globalCompositeOperation = 'source-in';
      octx.fillStyle = color;
      octx.fillRect(0, 0, GRID_NX, GRID_NY);
      const oldest = layers.current.keys().next();
      if (layers.current.size >= 16 && !oldest.done) layers.current.delete(oldest.value);
      layers.current.set(key, off);
      return off;
    };
    const topLeft = screenToGeo(view, size.w, 0, 0);
    const bottomRight = screenToGeo(view, size.w, size.w, size.h);
    const c0 = Math.max(0, Math.floor((topLeft.lon + 180) / GRID_STEP) - 1);
    const c1 = Math.min(GRID_NX, Math.ceil((bottomRight.lon + 180) / GRID_STEP) + 1);
    const r0 = Math.max(0, Math.floor((90 - topLeft.lat) / GRID_STEP) - 1);
    const r1 = Math.min(GRID_NY, Math.ceil((90 - bottomRight.lat) / GRID_STEP) + 1);
    if (c1 <= c0 || r1 <= r0) return;
    const origin = geoToScreen(view, size.w, 90 - r0 * GRID_STEP, -180 + c0 * GRID_STEP);
    const cell = GRID_STEP * UNITS_PER_DEG * baseScale(size.w) * view.k;
    const draw = (zone: string | null, token: string, alpha: number) => {
      if (!zone) return;
      const color = css.getPropertyValue(token).trim() || '#f59e0b';
      const layer = layerFor(zone, color);
      if (!layer) return;
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';
      ctx.globalAlpha = alpha;
      ctx.drawImage(layer, c0, r0, c1 - c0, r1 - r0, origin.x, origin.y, (c1 - c0) * cell, (r1 - r0) * cell);
      ctx.globalAlpha = 1;
    };
    draw(selected, '--map-selected', 0.62);
    if (highlight && highlight !== selected) draw(highlight, '--map-highlight', 0.55);
  }, [grid, size, view, selected, highlight, themeTick]);

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
