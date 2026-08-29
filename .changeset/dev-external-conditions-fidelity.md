---
'@solidjs/vite-plugin': patch
---

Dev servers now resolve the `development` export condition for externalized server deps. Externalized SSR imports are resolved with `resolve.externalConditions` (default `['node', 'module-sync']`), so packages selecting their dev build through the `development` condition — @solidjs/web's server-functions runtime among them — loaded their production copy under `vite dev`: thrown server errors reached the client sanitized to "Internal Server Error" instead of carrying the real message, and dev-only diagnostics vanished. The plugin now prepends `development` to each server environment's `externalConditions` whenever it injects dev mode, matching the treatment `resolve.conditions` already got.
