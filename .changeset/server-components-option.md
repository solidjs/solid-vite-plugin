---
'@solidjs/vite-plugin': minor
---

add `serverFunctions: { components: true }` (experimental): server components ride server functions with zero extra plugin config — the dev middleware and production handler serve component responses automatically, and SSR start mode's generated entries emit the document wiring (render plugin, bootstrap script, client `installServerComponents()` call)
