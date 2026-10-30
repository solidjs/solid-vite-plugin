---
'@solidjs/vite-plugin': patch
---

Add the `StartRequestEvent` type: the request event in start mode, with the `response` head every start-mode event carries and the optional `nativeEvent`. `StartMiddleware` now receives it, so `event.response.headers.set(...)` type-checks in middleware; `@solidjs/web`'s base `RequestEvent` declares neither field.
