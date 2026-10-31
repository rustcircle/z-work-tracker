import './zones.css';

/**
 * About text for the map and time zone data. The names and licences below are the ones stated in the
 * packages' own files: @photostructure/tz-lookup (licence field CC0-1.0, README: data sourced from
 * timezone-boundary-builder), world-atlas (ISC, redistributes Natural Earth) and topojson-client (ISC).
 */
export function ZoneDataAttribution() {
  return (
    <section className="zn-attribution" aria-labelledby="zn-attr-title" data-testid="zone-data-attribution">
      <h3 id="zn-attr-title">Map and time zone data</h3>
      <ul>
        <li>
          Time zone boundaries: <strong>timezone-boundary-builder</strong> by Evan Siroky, packaged as{' '}
          <strong>@photostructure/tz-lookup</strong>, released under CC0 1.0 (public domain dedication).
        </li>
        <li>
          Country outlines: <strong>Natural Earth</strong>, 1:50m, redistributed as TopoJSON by the <strong>world-atlas</strong> package
          (ISC licence) and read with <strong>topojson-client</strong> (ISC licence).
        </li>
      </ul>
      <p className="muted">
        All map data is bundled with the app, so the map makes no network requests. Outlines are drawn without labels for orientation only
        and take no position on borders, names or status. Finding a zone from a point on the map is approximate near borders; the list is the
        exact choice.
      </p>
    </section>
  );
}
