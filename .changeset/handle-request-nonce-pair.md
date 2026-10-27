---
'@solidjs/vite-plugin': patch
---

`handleRequest(request, { nonce })` accepts the `{ script, style }` form of `@solidjs/web`'s `CSPNonce` and uses its `script` value for the scripts the handler writes: the injected client-entry tag and the post-flush redirect fallback. A pair used to throw `TypeError: value.replace is not a function`. A value outside `CSPNonce` (anything but a string or a `{ script, style }` object with both keys, each a non-empty string or `false`) now rejects the call up front with an error naming the option, before the middleware chain runs; an empty value (`undefined`, `null` or `''`) still means no nonce. The option is now declared in the `virtual:solid-ssr-handler` types.
