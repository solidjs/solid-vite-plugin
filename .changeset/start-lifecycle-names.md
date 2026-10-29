---
'@solidjs/vite-plugin': patch
---

Rename `start.setup` to `start.serverRenderSetup` and `start.instrument` to `start.serverSetup`, so the start lifecycle options say where and how often they run: `serverSetup` once before anything else on the server, `middleware` on every request, `serverRenderSetup` before every page render, `clientSetup` once in the browser. The old keys fail at config time with a message naming the replacement.
