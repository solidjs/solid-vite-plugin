---
"@solidjs/vite-plugin": patch
---

Keep a request target that starts with `//` as the request path. The Node-to-web bridge resolved `req.url` against the host as a relative URL, so `GET //evil.example/api/x` produced a `request.url` of `http://evil.example/api/x`, letting a client choose the origin seen by origin checks and absolute redirects. The node entry's static file lookup and the dev and preview middlewares parse the path the same way now.
