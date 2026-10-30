import { defineConfig } from 'vitest/config';
import solidPlugin from '../../src/index.js';

// jsdom suite (`pnpm test:jsdom`). The default vitest.config.ts runs the
// browser-mode suite and excludes tests/jsdom.
export default defineConfig({
  plugins: [solidPlugin()],
  test: {
    environment: 'jsdom',
    include: ['tests/jsdom/**/*.test.tsx'],
  },
});
