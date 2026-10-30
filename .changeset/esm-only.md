---
'@solidjs/vite-plugin': patch
---

Ship the plugin as ESM only, which makes the package about 1 MB smaller unpacked. Vite is ESM-only already, and on the supported Node versions (22.12 and later) `require('@solidjs/vite-plugin')` loads the ESM build with the same exports (Node 22.12 prints a one-time experimental warning; 22.13 and later don't).
