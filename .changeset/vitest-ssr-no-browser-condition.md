---
'vite-plugin-solid': patch
---

In jsdom and happy-dom tests, Node no longer gets the `browser` condition for packages that Vitest leaves external. Node-only packages such as `msw/node` now load under Vitest 4 and later (#125).
