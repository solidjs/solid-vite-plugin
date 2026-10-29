---
'vite-plugin-solid': patch
---

Server builds with `ssr.target: 'webworker'` now resolve the server build of `solid-js`. The plugin adds the `worker` export condition to that build, so `renderToString` and the other server APIs no longer resolve to their browser stubs (#153). This works on Vite 4 and later.
