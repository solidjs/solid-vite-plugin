---
'@solidjs/vite-plugin': patch
---

With `serverFunctions` on, the dev server now pre-bundles the server-function client runtime even without `components` (`@solidjs/web/server-functions`, or `runtime.client` when it names a package), so a cold cache no longer re-optimizes and reloads on the first `"use server"` module. In Vitest browser mode that reload showed up as "Vite unexpectedly reloaded a test".
