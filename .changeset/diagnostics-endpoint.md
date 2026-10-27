---
'@solidjs/vite-plugin': minor
---

New `diagnostics` option (dev serve only): injects a client module that installs the in-page bridge from the app's own `@solidjs/diagnostics` and serves a `/__solid/diagnostics` endpoint on the dev server. Out-of-process consumers (agents, tests, curl) drive capture sessions (`begin`/`end`), `whyDidRun`, and cost queries over the Vite WebSocket. Works for plain index.html apps (transformIndexHtml injection) and start mode (generated/custom client entry injection). `@solidjs/diagnostics` is a type-only dependency of the plugin; the runtime bridge always comes from the app's installed copy.
