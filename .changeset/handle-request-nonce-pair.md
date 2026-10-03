---
'@solidjs/vite-plugin': patch
---

`handleRequest(request, { nonce })` accepts the `{ script, style }` form of `@solidjs/web`'s `CSPNonce` and uses its `script` value for the scripts the handler writes: the injected client-entry tag and the post-flush redirect fallback. A pair used to throw `TypeError: value.replace is not a function`. The option is now declared in the `virtual:solid-ssr-handler` types.
