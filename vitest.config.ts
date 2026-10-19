import { defineConfig } from 'vitest/config';

// The plugin's own unit tests (`pnpm test:unit`). The example apps under
// examples/* carry their own vitest configs and run through `pnpm test`.
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
  },
});
