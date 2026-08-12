---
'@solidjs/vite-plugin': patch
---

Turnkey server functions: `serverFunctions: true` now gives a fully working
setup with no manual wiring.

- Dev: a middleware on the Vite dev server handles the endpoint (default
  `/_server`, joined with `base`) end to end — it maps the incoming function
  ID back to its module through the compiler manifest, loads it in the SSR
  environment so the registration exists (even for functions only client
  code references, before any SSR render has run), scopes the request with
  `provideRequestEvent`, and dispatches to `handleServerFunctionRequest`,
  streaming bodies in both directions.
- Prod: import `virtual:solid-server-function-handler` in the server entry
  and mount its `handleServerFunctionRequest(request)` export on the endpoint
  — one line, router-agnostic. The module eagerly imports every module
  containing server functions (via the persisted manifest, so tree-shaking
  can't drop registrations), configures the endpoint, and scopes requests
  with `provideRequestEvent`. Vite preview has no SSR runtime, so prod always
  goes through this mount.
- New `endpoint` option on `ServerFunctionsOptions`, threaded to the dev
  middleware, the virtual handler, and — whenever the resolved path differs
  from the runtime default — `configureServerFunctions{Client,Server}` calls
  appended to compiled modules, so the client transport and rendered
  reference `.url`s agree without any manual configure call.
- Bring-your-own wiring keeps working: the standalone `serverFunctions()`
  export (used by meta-frameworks like SolidStart) never installs the dev
  middleware, compiled output is byte-identical when the endpoint resolves to
  the default, and the virtual handler only activates if imported.
