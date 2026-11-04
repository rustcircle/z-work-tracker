import { defineConfig, devices } from '@playwright/test';

// PW_PORT lets several checkouts run the suite at once, each on its own port.
const port = Number(process.env.PW_PORT ?? 4173);

// Runs the production-shaped bundle with the real CSP header, against the IPC mock in src/mocks.
export default defineConfig({
  testDir: 'e2e',
  timeout: 60_000,
  fullyParallel: true,
  workers: 32,
  reporter: [['list']],
  use: { ...devices['Desktop Chrome'], baseURL: `http://localhost:${port}`, viewport: { width: 1360, height: 900 } },
  webServer: {
    command: `pnpm build:e2e && pnpm exec vite preview --outDir dist-e2e --port ${port} --strictPort`,
    url: `http://localhost:${port}`,
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
