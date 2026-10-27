---
"@solidjs/vite-plugin": patch
---

The persisted server-function manifest (`dist/client/.vite/solid-server-functions.json`) now records every server function the client build can reach, by wire id, alongside the module list: `{ modules: string[], functions: Array<{ id, name, module }> }`. Build tooling that needs the client-reachable set — a static-site prerenderer verifying that each reachable function was captured at build time, for example — reads it from here instead of re-deriving it from compiled output. The previous array shape is still accepted when read (the type is exported as `PersistedServerFunctionManifest`).
