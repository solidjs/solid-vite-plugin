---
'vite-plugin-solid': patch
---

Production builds now dedupe `solid-js` the same way dev does. A dependency with its own nested copy of `solid-js` no longer adds a second runtime to the bundle, which broke context lookups (#112).
