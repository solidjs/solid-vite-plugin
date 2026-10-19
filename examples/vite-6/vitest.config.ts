import { configDefaults, defineConfig } from 'vitest/config';
import solidPlugin from '../../src/index.js';

export default defineConfig({
  plugins: [solidPlugin()],
  resolve: {
    conditions: ['development', 'browser'],
  },
  test: {
    environment: 'node',
    // tests/jsdom runs under vitest.jsdom.config.ts (`pnpm test:jsdom`).
    exclude: [...configDefaults.exclude, 'tests/jsdom/**'],
    browser: {
      enabled: true,
      provider: 'playwright',
      instances: [{ browser: 'chromium' }],
    },
  },
});
