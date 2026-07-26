---
'vite-plugin-solid': patch
---

Allow `@testing-library/jest-dom` v7 in the optional peer dependency range. v7 keeps the `@testing-library/jest-dom/vitest` subpath the plugin auto-injects into `test.setupFiles`, so no code change is needed, only the range widening that unblocks npm's peer resolution.
