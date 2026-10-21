---
'@solidjs/vite-plugin': patch
---

The plugin no longer sets `test.environment: 'jsdom'` for Vitest. Set the
environment yourself (`jsdom` or `happy-dom` for DOM component tests); Vitest's
own default is `node`. The default also applied to Node-only suites that loaded
the plugin through a shared config, which then ran under jsdom and failed in
ways that were hard to trace. The client test posture (browser conditions, DOM
codegen) is unchanged, and `environment: 'node'` still selects the server
posture.
