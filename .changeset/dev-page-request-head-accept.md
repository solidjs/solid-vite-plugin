---
'@solidjs/vite-plugin': patch
---

Under `vite dev`, pages now answer HEAD requests, and GET requests with `Accept: */*` or no Accept, the way production does. Before, these got Vite's 404. The page-request test now matches Vite's own HTML fallback.
