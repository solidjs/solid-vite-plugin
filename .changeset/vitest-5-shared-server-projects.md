---
'@solidjs/vite-plugin': patch
---

When the root config declares `test.projects` and leaves `test.sharedViteServer` unset, the plugin now sets it to `false` so every inline project resolves its own Vite config, as under Vitest 4; an explicit value is respected. Vitest 5 defaults the option to `true`, and a shared inline project takes its `test` options from the raw root block captured before any `config` hook runs, so it lost everything the plugin injects (posture, the `@testing-library/jest-dom` setup file, `server.deps`). Refs #369.
