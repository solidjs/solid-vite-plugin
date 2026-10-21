---
'@solidjs/vite-plugin': patch
---

In jsdom and happy-dom tests, Node no longer gets the `browser` condition for packages that Vitest leaves external. Node-only packages such as `msw/node` now load (#125).
