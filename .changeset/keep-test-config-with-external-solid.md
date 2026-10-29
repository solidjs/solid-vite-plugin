---
'vite-plugin-solid': patch
---

Vitest runs keep the `jsdom` environment and the `@testing-library/jest-dom` setup file when `test.server.deps.external` already lists `solid-js`. The plugin used to drop its whole `test` config in that case.
