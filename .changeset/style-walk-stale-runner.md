---
'@solidjs/vite-plugin': patch
---

Start mode dev no longer serves a stale module after an edit to a module a lazy route imports (#537). The dev asset resolver's style walk re-transformed invalidated SSR modules before the module runner imported them, and Vite's `fetchModule` then answered the runner's `cached: true` request with `{ cache: true }`, so the runner kept its old copy until the dev server restarted. This affected runners that rely on that handshake instead of a full reload, such as workerd under `@cloudflare/vite-plugin`. The plugin now wraps the SSR environment's `fetchModule`: it records each module's invalidation timestamp from before the runner received its code, and answers a later cached request with fresh code and `invalidate: true` when the module was invalidated since. The walk calls the unwrapped `fetchModule`, so it no longer changes what the runner sees, and no module is evaluated twice.
