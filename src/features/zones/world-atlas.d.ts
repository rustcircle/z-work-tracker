// The country outlines ship as a JSON file inside the world-atlas package. Typing it as `unknown`
// keeps the compiler from inferring a 750 KB literal type; mapData.ts validates the shape at runtime.
declare module 'world-atlas/countries-50m.json' {
  const topology: unknown;
  export default topology;
}
