---
'@solidjs/vite-plugin': patch
---

Rename `start.setup` to `start.renderSetup` and `start.instrument` to `start.serverBootstrap`, so the start lifecycle options say where and how often they run: `serverBootstrap` once before anything else on the server, `middleware` on every request, `renderSetup` before every page render, `clientSetup` once in the browser. The old keys fail at config time with a message naming the replacement.
