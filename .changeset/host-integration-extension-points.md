---
'@solidjs/vite-plugin': patch
---

Three extension points for composing the plugin with host environments
(e.g. @cloudflare/vite-plugin) without giving up the turnkey option forms:

- New `serverFunctions.devMiddleware` option (default `true`): set `false`
  to keep the plugin's dev middleware off the endpoint so a host's server
  environment owns dispatch in dev — functions then run where the bindings
  live (e.g. workerd), exactly like production. Compilation and the
  manifest/handler virtual modules keep working; the host loads
  `virtual:solid-server-function-handler` itself and calls its
  `handleServerFunctionRequest(request)` export (and should side-effect
  import `virtual:solid-server-function-manifest` in its server entry to
  cover functions referenced only by client code, since the middleware's
  on-demand loading is off too).
- Client-before-server build ordering in builder-mode (environments API)
  app builds, absorbed into the plugin: with `ssr` enabled, a pre-order
  `buildApp` hook (Vite 7.1+) builds the client environment (manifest and
  all) before any other orchestrator runs, so setups whose orchestrator
  builds server environments first — @cloudflare/vite-plugin builds workers
  before the client — no longer need a hand-written ordering plugin for the
  server bundle to bake real hashed assets. A post-order hook reinstates
  Vite's build-everything fallback when no other orchestrator built
  anything, so plain `builder: {}` setups (turnkey included) behave exactly
  as before, just explicitly client-first.
- New `serverFunctions.configure` option: path to a server-only module
  (resolved against the Vite root) that the generated
  `virtual:solid-server-function-handler` module side-effect imports before
  any dispatch. The guaranteed pre-dispatch home for server-side runtime
  registration — e.g. `configureServerFunctionsServer({ collectFlightData })`
  for a router's single-flight collector — effective on both dispatch
  surfaces (dev middleware and production handler, where it bundles into
  the handler chunk), immune to the dev-restart race where app-graph
  registration only loads with the first page render, and hot-invalidating
  the handler when edited in dev.
