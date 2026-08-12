---
'@solidjs/vite-plugin': patch
---

The start-mode dev middleware dispatches every request through the `start.middleware` chain — all methods and accept types, matching production and preview — instead of only HTML-accepting GETs. API routes (GET/POST exports served by a middleware like filesystem-routing's `createAPIHandler`) and no-JS form POSTs now work under `vite dev`. Non-page requests the chain does not handle fall back to Vite's own pipeline (its 404) rather than getting a page rendered at them, and without a configured middleware nothing changes: non-page requests never leave Vite's pipeline.
