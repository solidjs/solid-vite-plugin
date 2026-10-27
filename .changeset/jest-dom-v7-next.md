---
'@solidjs/vite-plugin': patch
---

Allow `@testing-library/jest-dom` v7 in the optional peer dependency range (ports #287 from `main`). The Solid 2.0 templates pin `@testing-library/jest-dom@^7.0.0`, and npm 7+ enforces peer ranges, so a clean `npm install` of a freshly created project failed with `ERESOLVE` against the `^6.*` range (solidjs/solid#3341). v7 keeps the `@testing-library/jest-dom/vitest` subpath the plugin auto-injects into `test.setupFiles`, so only the range changes.
