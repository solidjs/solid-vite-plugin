---
'@solidjs/vite-plugin': patch
---

`start.node` with `start.instrument`: `dist/server/node.js` no longer loads `node:http` before the instrument module runs, so OpenTelemetry's HTTP instrumentation now records a server span for each request. The entry awaits `./server.js` first and loads its runtime from `node-runtime.js` afterwards.
