import { defineConfig, devices } from '@playwright/test';

// Runs the production-shaped bundle with the real CSP header, against the IPC mock in src/mocks.
export default defineConfig({
  testDir: 'e2e',
  timeout: 60_000,
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  use: { baseURL: 'http://localhost:4173', viewport: { width: 1360, height: 900 }, ...devices['Desktop Chrome'] },
  webServer: {
    command: 'pnpm build:e2e && pnpm exec vite preview --outDir dist-e2e',
    url: 'http://localhost:4173',
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
