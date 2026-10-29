---
'vite-plugin-solid': patch
---

Fix `TypeError: Cannot read properties of undefined (reading 'extend')` in tests on Vitest before 1.0 with `@testing-library/jest-dom` 6 or later installed (#141). The plugin now injects jest-dom's ESM `vitest` entry as an absolute path for those Vitest versions, because they load the CommonJS entry from a bare specifier.
