---
'@solidjs/vite-plugin': patch
---

Pre-bundle `@solidjs/signals` up front under `vite dev` (and Vitest browser
mode) when the app can import it by name, i.e. it resolves from the project
root. The first optimizer pass otherwise inlines signals into `solid-js`, so a
direct `@solidjs/signals` import from a module the scanner never reached (a
browser-mode test file, a non-literal dynamic import) was a late discovery:
re-optimize and a full page reload ("Vite unexpectedly reloaded a test").
Apps that only get signals transitively (pnpm's isolated layout) are
unchanged.
