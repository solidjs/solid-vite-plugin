---
'@solidjs/vite-plugin': patch
---

The exported `serverFunctions()` now takes only its options. The second parameter it used to declare was internal wiring for the main plugin's `serverFunctions` option (dev middleware, SSR handler, TSRX ordering), which the standalone export should never set; it moved to an internal factory, so it is no longer part of the public types.
