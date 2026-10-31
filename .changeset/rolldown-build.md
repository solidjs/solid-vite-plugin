---
'@solidjs/vite-plugin': patch
---

Build the package with Rolldown instead of Rollup and Babel. The published bundle no longer carries source comments (its sourcemap still embeds the commented sources), which makes `dist/esm/index.mjs` about 40% smaller.
