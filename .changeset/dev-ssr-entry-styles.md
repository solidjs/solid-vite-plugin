---
'@solidjs/vite-plugin': patch
---

SSR start mode: dev responses now inline the entry graph's CSS, fixing the
flash of unstyled content. The dev middleware walks the SSR module graph
from the root entry (the app + document for generated entries, the authored
server entry otherwise), compiles each transitively imported stylesheet
through the client environment, and SSRs them as
`<style data-asset data-vite-dev-id>` tags in `<head>` — the same shape the
lazy-asset system emits, so Vite's client adopts them on startup (CSS HMR
updates the adopted tag in place) and the dev style patch dedupes any
late-injected twin. Previously entry CSS only arrived when the client entry
JS executed, so server-painted markup flashed unstyled in dev; production
was always fine (manifest-driven `<link rel="stylesheet">`).
