---
'vite-plugin-solid': patch
---

Without `ssr: true`, modules loaded on the server now compile to non-hydratable SSR output instead of DOM output. Prerendering a client-rendered app with `ssrLoadModule` no longer throws "Client-only API called on the server side" (#64). Vitest keeps DOM output.
