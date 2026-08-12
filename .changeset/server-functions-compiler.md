---
'@solidjs/vite-plugin': patch
---

`"use server"` server function compilation (experimental), hoisted from
SolidStart 2.0 alpha's directive compiler. Enable it through the new
`serverFunctions` option on the main plugin, or compose the standalone
`serverFunctions(options)` export for full control over plugin ordering
(e.g. relative to a file-system router). To support emitting the transform
sub-plugins, `solid()` now returns `Plugin[]` instead of a single `Plugin` —
transparent at the Vite config level, where plugin arrays flatten.

- Both directive forms are supported: function-level (first statement of a
  function body) and module-level (every export becomes a server function).
  Server builds register the original function via `registerServerReference`
  and reference it with `createServerReference`; client builds compile to
  ID-only references with the function bodies — and everything only they
  used, including module-level server-only code — removed.
- The runtime is bring-your-own: compiled output imports the two reference
  functions from the module specifiers in `options.runtime.{server,client}`,
  so SolidStart's runtime, or a minimal custom one (see the
  `examples/server-functions` fixture built on `@solidjs/web/serialization`), can
  satisfy the ABI. Works identically under the Babel and native compiler
  backends since the transform runs as its own pre-pass (server functions
  live in plain `.ts`/`.js` files the JSX pass never sees).
- A virtual manifest module (default `virtual:solid-server-function-manifest`)
  imports every module containing server functions; import it for side
  effects in the server entry so registrations exist before dispatch. Server
  functions referenced only from client-side code (e.g. event handlers,
  which the SSR JSX compile drops) are discovered by the client transform
  and fed into the server manifest — across the classic two-invocation build
  via `dist/client/.vite/solid-server-functions.json`.
- Divergences from the SolidStart source: function IDs hash the
  project-relative path (reproducible across machines while still agreeing
  between the client and server builds) and modules without the directive
  substring skip the Babel parse entirely.
