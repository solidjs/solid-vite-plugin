---
'@solidjs/vite-plugin': patch
---

Server builds with `ssr.target: 'webworker'` now resolve the server builds of `solid-js` and `@solidjs/web`. The plugin adds the `worker` export condition to that environment, so `renderToString` and the other server APIs no longer resolve to their browser stubs (#153).
