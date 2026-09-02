---
'@solidjs/vite-plugin': patch
---

`serverFunctions.components` now also accepts `'external'`: identical to `true`, but declares that a composing host (e.g. the Astro adapter or TanStack Start's Solid integration) owns the document wiring — render plugin + client-side `installServerComponents()` call — itself, so the without-SSR-start-mode warning is skipped instead of printing on every host build. The remaining warning text is also updated: it listed "the bootstrap script" as a required app-side piece, but head bootstrap injection was removed (serialized references self-bootstrap the registry), and it now points hosts at `components: 'external'`.
