---
'vite-plugin-solid': patch
---

Turnkey SSR closes the middleware early-return gap with the runtime's `commitEventResponse`: a middleware that answers without calling `next()` (an API handler) bypasses `createSSRResponse`, so its request-scope stub writes — cookies appended to `event.response.headers`, status — never reached the wire. The generated handler now applies `commitEventResponse(response, event)` unconditionally at the handler edge, strictly after the outermost middleware returns: headers stay mutable through the whole unwind, committed page responses pass through untouched (the fold is idempotent), and the inner per-path folds (`applyResponseStub` on raw `entry.render` Responses and server-function responses) collapse into the one edge fold.

Until the next `@solidjs/web` repin ships `commitEventResponse` (TODO(.40-repin) in the codegen), the handler resolves it off a namespace import with a local fallback that preserves the previous partial fold semantics — a named import of a missing export would be fatal in ESM — so generated modules keep working against the current beta.31 line and upgrade to the runtime's fold (protocol-header denylist, committed-stub loudness) automatically at the repin.
