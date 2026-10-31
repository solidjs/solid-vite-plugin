import { defineConfig, devices } from '@playwright/test';

// The example scripts/test-examples.ts just built, served by `vite preview`.
const example = process.env.EXAMPLE ?? 'vite-8';
const port = 4173;

export default defineConfig({
  testDir: 'e2e',
  forbidOnly: !!process.env.CI,
  globalTimeout: 5 * 60_000,
  use: { baseURL: `http://localhost:${port}` },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: `pnpm --dir examples/${example} preview --port ${port} --strictPort`,
    url: `http://localhost:${port}`,
  },
});
