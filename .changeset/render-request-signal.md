---
'@solidjs/vite-plugin': patch
---

The generated server entry passes the request's `signal` to `renderToStream`, so a render still pending when the client disconnects is disposed (#467).
