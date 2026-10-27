---
'@solidjs/vite-plugin': patch
---

The generated start-mode server handler no longer imports `scriptNonce`/`styleNonce` from `@solidjs/web`. It projects each destination of a `{ script, style }` nonce with a local helper instead. Those helpers are internal to `@solidjs/web` (solidjs/solid#4016), and its single-script surfaces now take the full `CSPNonce` themselves. The handler works with `@solidjs/web` versions both before and after that change.
