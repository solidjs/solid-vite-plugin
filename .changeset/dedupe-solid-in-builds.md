---
'@solidjs/vite-plugin': patch
---

Production builds now dedupe `solid-js`, `@solidjs/web` and `@solidjs/signals` the same way dev does. A dependency with its own nested copy of Solid no longer adds a second runtime to the bundle, which broke context lookups (#112).
