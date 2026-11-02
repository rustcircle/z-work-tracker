import { readFileSync } from 'node:fs';

import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

/** The app's real production CSP, so e2e runs catch anything it would block. */
function productionCsp(): string {
  const conf = JSON.parse(readFileSync('src-tauri/tauri.conf.json', 'utf8')) as {
    app: { security: { csp: Record<string, string> } };
  };
  return Object.entries(conf.app.security.csp)
    .map(([k, v]) => `${k} ${v}`)
    .join('; ');
}

// Relative base, no CDN: every asset ships inside the app.
export default defineConfig({
  plugins: [react()],
  preview: { port: 4173, strictPort: true, headers: { 'Content-Security-Policy': productionCsp() } },
  clearScreen: false,
  base: './',
  server: { port: 1420, strictPort: true },
  build: { target: 'es2022', chunkSizeWarningLimit: 2000 },
  test: {
    environment: 'jsdom',
    globals: false,
    setupFiles: ['src/test-setup.ts'],
    include: ['src/**/*.test.{ts,tsx}', 'scripts/**/*.test.ts'],
    exclude: ['src/**/*.perf.test.ts', 'node_modules'],
    // The Windows CI runner is slow enough that a component test, which boots the whole app, has run past the 5 s
    // default. GitHub Actions sets CI=true. Locally the default stays, so a test that hangs still fails fast.
    testTimeout: process.env.CI ? 30_000 : 5_000,
  },
});
