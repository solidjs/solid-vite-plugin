---
'vite-plugin-solid': patch
---

Load the client build of solid-js in test files that set `// @vitest-environment node` when `test.environment` is `jsdom` or `happy-dom`. The `ssr` environment keeps the `browser` condition again, and only the conditions Vitest passes to Node leave it out, so `msw/node` still loads.
