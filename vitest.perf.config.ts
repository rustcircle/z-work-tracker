import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: { environment: 'node', include: ['src/**/*.perf.test.ts'], testTimeout: 120_000 },
});
