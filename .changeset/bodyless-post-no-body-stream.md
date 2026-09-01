---
"@solidjs/vite-plugin": patch
---

Only attach a request body in the dev middlewares' Node-to-web bridging when the incoming request actually carries one (Content-Length/Transfer-Encoding, or the h2 END_STREAM flag). An unconditionally attached empty stream made bodyless POSTs — zero-argument scripted server function calls, synthetic dispatches — parse as a present-but-unusable body, which @solidjs/web 2.0.0-rc.5 rejects as malformed (400) instead of ignoring.
