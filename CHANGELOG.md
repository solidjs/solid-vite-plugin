# Changelog

## 3.0.0-next.32

### Patch Changes

- 2436bf5: Wire the Start development error boundary into server rendering and support direct `@solidjs/start-devtools` imports in apps with custom server and client entries.
- 473afd2: Start devtools are no longer enabled when `@solidjs/start-devtools` is not installed. Detection falls back to resolving the package from the plugin's own file (for pnpm-isolated installs where it is only a dependency of the plugin), but the package is declared an optional peer dependency of the plugin, so when it is absent Vite answers that resolution with its `__vite-optional-peer-dep:` stub instead of `null`. The plugin took the stub as a successful resolution, wrapped the generated client entry in `DevToolbar`, and the browser failed with `The requested module '/@id/__vite-optional-peer-dep:@solidjs/start-devtools:@solidjs/vite-plugin' does not provide an export named 'DevToolbar'`. The stub is now treated as "not installed".
- 791ae3e: Require Vite 8 or newer and remove the Vite 6 and 7 compatibility paths.

## 3.0.0-next.31

### Minor Changes

- 8459560: New `start.devtools` option: a development toolbar with runtime errors and a
  server function inspector, backed by the new optional-peer package
  `@solidjs/start-devtools`. By default the toolbar turns on in `vite dev`
  whenever the package resolves (install it as a dev dependency) and stays off
  otherwise; `start: { devtools: true }` makes the package required (a missing
  install becomes an error) and `start: { devtools: false }` opts out entirely.
  Generated client entries wrap the app in the toolbar's `DevToolbar` component,
  authored client entries get an injected mount import instead, and either way
  the wiring is dev-serve-only codegen — production builds and previews contain
  none of it. The package itself is resolved from the app graph first and from
  the plugin's own location as a fallback, and the virtual toolbar modules
  delegate their imports to that captured resolution, so pnpm-isolated installs
  work without the package being hoisted to the app root.

### Patch Changes

- c8615ed: Apply the request CSP nonce to start mode's generated client-entry script.
- 7c10d3b: Add a generic production error boundary to generated Start entries. It returns a 500 response for uncaught SSR errors and provides a fallback for uncaught client errors. Set `start.errorBoundary` to `false` when application middleware owns error handling.
- e607db7: Add `start.css.filter` to control which module graphs are traversed while collecting development CSS. `exclude` prunes matching graphs (defaults to `/node_modules/`; providing one replaces the default), and `include` opts matching files in on top of that baseline — e.g. `{ include: /node_modules\/some-ui-lib/ }` server-inlines that dependency's CSS in dev. A file matching both patterns stays excluded.
- 450d0e5: Add Vite 9 forward compatibility by using the per-environment consumer in plugin hooks and accepting Vite 9 as a peer.

## 3.0.0-next.30

### Patch Changes

- fbb5239: Unlock the @dom-expressions/compiler dependency from the exact 0.50.0-next.40 pin to the `^0.50.0-next.43` range — floors at next.43, auto-graduates to later next.N and stable 0.50.0, matching how babel-preset-solid is ranged. Absorbs the .41–.43 compiler fixes: dedicated `<!>` insertion markers for components boxed by static text (solidjs/solid#3004, content no longer lands after the trailing text), `$key` on intrinsic server JSX compiling to a `_key` attribute so the frame morph matches keyed elements by key instead of position, `transformLazy` annotating the module-URL placeholder in `lazy()`'s third argument for solid-js 2.0's `{ export }` options bag (solidjs/solid#3011), HTML-escaping of static template-literal parts in attribute/style values, innerHTML/textContent holes no longer taking the `_$scope` id reservation (solidjs/solid#3015), and the Rust 1.95 / Oxc 0.144 toolchain upgrade with the WASI linking fix.
- 5543386: Fixes the dev server crashing on every request under https/HTTP/2. Vite serves `server.https` through an HTTP/2 server (with HTTP/1 fallback), and the plugin's Node→web request bridge copied the h2 pseudo-headers (`:path`, `:method`, `:authority`, `:scheme`) into `Headers`, which throws `TypeError: ":path" is an invalid header name` — so start-mode SSR and server functions 500'd on every request over `vite dev` with https. Pseudo-headers are now skipped and the host derives from `Host` or the h2 `:authority`. Alongside it, three more bridge hardenings (techniques referenced from srvx's Node adapter, h3js/srvx): `request.url` now says `https:` on TLS sockets instead of always `http:` (secure-cookie logic, absolute redirects, and origin checks in app code saw the wrong protocol), client disconnects now fire the request's `AbortSignal` so handlers can cancel streamed renders and in-flight work, and HEAD requests end immediately with the response body cancelled instead of pumping the whole (possibly endless) stream into Node's discarded HEAD writes.

## 3.0.0-next.29

### Minor Changes

- 24747b7: `options.event`: the public wrapper→event extension seam on the generated handlers. Fields passed as `handleRequest(request, { event })` (and `handleServerFunctionRequest(request, { event })` on the standalone server-function handler, threaded through its `createEvent` option) spread into the request event at creation, so hosts and custom server entries can extend what `getRequestEvent()` answers with — no new convention beyond `createRequestEvent`'s own init parameter. The conventional field is `nativeEvent`, the platform's raw request object: the plugin's own dev, preview, and server-function dev middlewares now pass `event: { nativeEvent: req }` (the Node `IncomingMessage`), so `getRequestEvent().nativeEvent` reads the same under `vite dev`/`vite preview` as behind a production Node entry that passes it. The event shape itself is unchanged (`{ request, locals, response }` plus whatever the wrapper spreads in); nothing is attached to the `Request`, and no client-address helper is added — on bare Node read `event.nativeEvent.socket.remoteAddress`, behind a trusted proxy read the forwarding headers off `event.request`.

### Patch Changes

- 40c6865: Housekeeping: add the MIT LICENSE file the `license` field has always declared but the repo never carried (#219), and document `virtual:solid-manifest` in the README — what it exports in dev (the live asset resolver) versus SSR builds (the baked client manifest with `_base`), and its role as the seam for frameworks doing their own asset gating (e.g. the TanStack Start integration).
- ca4d221: `start.env`: the generated `virtual:env/server` module no longer contains
  top-level await, removing the esnext-target deploy requirement. Boot
  validation used to conditionally `await` each validator result (Standard
  Schema allows `validate()` to return a Promise), which put a TLA in the
  server env chunk whenever the schema had `server` keys — and any
  downstream bundler with a non-esnext target refuses a TLA chunk outright
  (Nitro's node-server preset is the one that bites in practice), forcing
  deployments to override the build target to `esnext`. Boot validation is
  now fully synchronous with identical semantics: same `process.env` read at
  module init, same per-key report, same fail-loud-at-boot before any
  importer's body runs, same frozen `env` export — and synchronous init is
  the only shape that can keep the "validated before first use" guarantee,
  since user server modules read `env.KEY` at their own top level (deferring
  the await to request entry cannot cover module-init consumers). The
  tradeoff is explicit: async validators (e.g. `z.string().refine(async
...)`) are no longer supported for `server` keys — they are rejected at
  config/build time with the fix in the message (they could only ever have
  failed at deploy boot otherwise), and boot backstops with the same report
  for schemas whose async-ness only surfaces on real values. `client` keys
  keep async support: their values are baked at build time, where the plugin
  awaits. The start-env suite now asserts every built server chunk
  transforms under esbuild target es2020 (which rejects TLA at parse time —
  exactly the check a downstream bundler applies) so this cannot regress.
- 3257a97: Vite 8's dependency scan no longer breaks on `.tsx` files (issue #262).
  The plugin previously set `optimizeDeps.rolldownOptions.transform.jsx:
'preserve'` to stop Rolldown from injecting `react/jsx-dev-runtime`
  imports during the scan — but the scanner re-parses the transformed
  output as plain JS (`import.meta.glob` handling force-tags modules as
  `js`, and even without glob the oxc-preserved JSX is re-parsed without
  JSX enabled), so any `.tsx` with JSX was a hard `PARSE_ERROR: Unexpected
JSX expression` that aborted the whole scan. Every dependency was then
  missed by pre-bundling and discovered at runtime instead ("new
  dependencies optimized" mid-session re-optimize/reload — the classic
  symptom for deps only reachable through `import.meta.glob`). The scan
  transform now uses the classic JSX runtime, which lowers JSX to bare
  `React.createElement` calls without injecting any import: the scan
  output is never executed, it only exists so rolldown can walk the import
  graph, so the undefined identifier is harmless. With this, the scan
  completes and glob-only dependencies are pre-bundled up front.

## 3.0.0-next.28

### Patch Changes

- fc5050f: update to solid 2.0.0-rc.0 — the solid-js/@solidjs/web peer ranges and the babel-preset-solid dependency move from `>=2.0.0-beta.32 <2.0.0-experimental.0` to `^2.0.0-rc.0`, admitting the rc line (which the old experimental-capped upper bound excluded, since `experimental` sorts before `rc`), still flooring above the hazardous 2.0.0-experimental.* publishes, and auto-graduating to stable 2.x

## 3.0.0-next.27

### Patch Changes

- 5ec1370: The package is renamed from `vite-plugin-solid` to `@solidjs/vite-plugin` (#156). Migration is the dependency name and the import specifier — `npm install -D @solidjs/vite-plugin`, `import solid from '@solidjs/vite-plugin'` — everything else is unchanged. A final `vite-plugin-solid` release re-exports this package (default and named exports, subpath type declarations included) so existing setups keep working, but new installs should use the new name. User-facing strings follow: config-time errors and dev-overlay messages are now prefixed `[@solidjs/vite-plugin]`, the ambient type subpaths are `@solidjs/vite-plugin/virtual-solid-manifest` and `@solidjs/vite-plugin/boundary-modules`, and the dev-manifest bridge endpoint is `/@solidjs/vite-plugin/dev-manifest`.

> **Package renamed.** Every version below this note was published to npm as
> [`vite-plugin-solid`](https://www.npmjs.com/package/vite-plugin-solid); the
> package is [`@solidjs/vite-plugin`](https://www.npmjs.com/package/@solidjs/vite-plugin)
> from 3.0.0-next.27 onward.

## 3.0.0-next.26

### Patch Changes

- 6dbb7e8: Start mode's generated request handler now default-exports a Fetchable
  `{ fetch(request) }` object alongside its named `handleRequest` export.
  Deployment integrations that follow the web-standard Fetchable convention
  can consume the virtual handler or built server entry without a wrapper.
  The `fetch` method intentionally ignores provider arguments after the request
  instead of forwarding them as Solid handler options.

  The normal `ssr` environment now exposes that handler as its `index` service
  entry. Provider Vite plugins can adopt the same environment for development
  and production without `start.external`, a custom source entry, or explicit
  Rollup input. Standalone builds continue to emit `dist/server/server.js`.

- 06aadc6: Don't default `test.environment` to jsdom for vitest browser-mode projects (`test.browser.enabled`): vitest 4 probes for the environment's package at startup and sets a failing exit code when jsdom isn't installed, even though the suite runs (and passes) in the real browser. Browser-mode projects now fall back to vitest's own node default, which has no package probe — mirroring the existing jest-dom gate. Non-browser projects keep the jsdom default.

## 3.0.0-next.25

### Patch Changes

- 11b87a1: Custom `extensions` work with the native compiler again. The native compiler picks its parser dialect from the file extension, so the transform builds a borrowed-extension filename (`foo.mdx` → `foo.mdx.jsx`, or `.tsx` when the extension is registered as TypeScript) for exactly this case — but only the lazy and refresh passes used it; the JSX transform itself still received the raw id, and `@dom-expressions/compiler` rejected it with "Unknown file extension" (#297). `compiler: 'babel'` was unaffected because that path names the parser plugins explicitly. The JSX transform now receives the same borrowed filename as the other native passes.
- 74fb28b: `start.env` now rejects `server` schema keys that carry the public env prefix at config time. Vite bakes every `VITE_`-prefixed variable (or whatever `envPrefix` selects) into the browser's `import.meta.env` regardless of which side of the schema declares it, so `server: { VITE_API_SECRET: ... }` silently shipped the secret to every client through Vite's own channel — the build-time leak scan does flag server values that land in client chunks as literals, but dev has no scan at all, and short or colliding values can evade the literal match. The prefix rule was previously enforced one-way (client keys must have it); the reverse guard now fails fast with a rename message, mirroring the existing client-side guard.
- 2e7b63c: `sendWebResponse` no longer hangs forever when a client disconnects during backpressure. The write loop's `'drain'` wait had no other way to settle, but a response whose client already went away never emits `'drain'` — so every streamed SSR response aborted mid-stream (closed tab, slow mobile client) parked the promise chain, the body reader, and the Response object permanently, accumulating leaks over a start mode dev/preview session. The backpressure wait now also settles on `'close'`/`'error'` and the loop bails out early once the response is destroyed, letting the existing close handler's reader cancellation finish cleanup.
- 84a4cab: docs: "turnkey" is now "start mode" across user-facing language — the JSDoc on `ssr`/`start`/`serverFunctions` and on `StartOptions`/`ServerFunctionsOptions`, the READMEs, and the config-time error/warning strings all say start mode (SSR start mode / client start mode; the server-function dev middleware is "built-in", since it works without `start`). The components-without-start warning also names the right option (`start`, not `app`). Prose citing Solid 2.0 beta versions is reworded version-neutrally now that 2.0 is past beta — published dependency ranges are untouched.

## 3.0.0-next.24

### Patch Changes

- dea55b3: Base-path and lazy-asset URL handling fixed across the start mode surfaces (#298, #299, #300). Vite's base middleware strips the configured `base` from `req.url` before post middlewares run, but the built handler compares the request pathname against the base-prefixed server-function endpoint and hands the URL to application code — so under a non-root `base`, `vite preview` never dispatched `/base/_server` (requests fell through to page rendering) and dev page SSR saw base-stripped URLs that production would never send. The plugin's node adapters (the preview middleware, the start-mode dev SSR middleware, and the server-function dev middleware when the stripped endpoint form matched) now restore the base before constructing the web `Request`, so the handler sees production-shaped URLs on every surface. The dev asset resolver's lazy module URLs get the same treatment: they were emitted as `"/" + key`, which Vite rejects outside a non-root base and which mis-normalizes for root-external modules — they are now base-prefixed, and keys outside the Vite root (`../…`, e.g. sibling workspace packages) resolve to `/@fs/` URLs; the generated `virtual:solid-manifest` dev fallback mirrors the same logic. Finally, module query strings survive the lazy asset lookup: `resolveLazyModuleUrls` and the SSR `$$moduleUrl` injection kept only the queryless path while Rollup keys the facade chunk (and the Vite manifest entry) by the queried module id, so `lazy(() => import('./Panel.tsx?variant=a'))` missed its production manifest entry and could load different plugin output in dev — the query is now part of the asset key end to end, matching the manifest and the dev URL.
- 3e5d8ff: Boundary guard no longer aborts Vite's dependency scan. The dep scanner
  (`vite:dep-scan`) crawls the raw import graph from the plugin's injected
  scan entries before any directive transform runs, so it walks straight
  through `'use server'` modules into genuinely server-only code — and the
  `server-only` marker's client-graph guard treated that as a violation,
  failing the whole scan on every cold `vite dev` start ("Failed to run
  dependency scan. Skipping dependency pre-bundling.") for any app whose
  server functions reach `server-only` code. The graph is legal once
  transforms split it, so the guard now stands down on scanner resolves
  (the `scan` flag Vite sets on plugin-container resolve options, both the
  esbuild scanner in v6/7 and the rolldown one in v8) while still claiming
  the specifier — the scanner must not chase `server-only`/`client-only` as
  missing bare dependencies, which would abort the scan all the same. Real
  dev and build module graphs resolve without the flag and stay fully
  guarded: a client-side import of a `server-only` module is still a build
  error naming the importer.
- e180576: The dev-manifest bridge resolver no longer caches failed lookups. The convergence cache introduced for the nested-lazy render-pass fix stored the `null` a bridge failure resolves to, so one transient miss (dev server briefly unreachable, non-OK response) silently stripped that module's client assets — and its hydration preload entry — for the rest of the dev session. Only successful answers are cached now; failures keep logging loudly and stay retryable, while in-flight dedupe still hands retries of the same render pass a stable promise, so convergence is unaffected.
- 23965a2: The dev asset resolver now caches per module key and answers synchronously once a key's assets are known (in-flight walks are deduped; any watcher event drops the cache so dev CSS stays fresh). Server-side `lazy()` re-requests a module's assets on every retry of a suspended render pass — the router's nested outlets re-create the component per retry — and an always-async resolver suspends every retry on a brand-new promise, so the pass never converges: any nested route hung `vite dev`, or overflowed the render stack (one resume closure nests per cycle) and the escaped rejection killed the dev server. The build manifest never looped because it answers synchronously; dev now matches it after the first resolution. The HTTP bridge resolver for isolated SSR runners (nitro dev worker, workerd) gets the same convergence cache.
- a2bd979: The start-mode dev middleware dispatches every request through the `start.middleware` chain — all methods and accept types, matching production and preview — instead of only HTML-accepting GETs. API routes (GET/POST exports served by a middleware like filesystem-routing's `createAPIHandler`) and no-JS form POSTs now work under `vite dev`. Non-page requests the chain does not handle fall back to Vite's own pipeline (its 404) rather than getting a page rendered at them, and without a configured middleware nothing changes: non-page requests never leave Vite's pipeline.
- ec7543f: Doc examples for `serverFunctions.configure` import `configureServerFunctionsServer` from the type-correct `@solidjs/web/server-functions/server` subpath (the base subpath's types are the client surface and don't declare it).
- 6e2d526: Start-mode typed env (`start.env`): first-party typed, validated environment
  variables for both start modes. A schema file at the project root —
  `env.ts`/`env.js`, probed automatically (explicit via `start.env: './path'`,
  off via `false`) — default-exports `{ server, client }` maps of Standard
  Schema validators (zod, valibot, arktype, mixable per key; nothing imported
  from the plugin), and the validated values come back through two typed
  virtual modules: `virtual:env/server` (every var, server module graphs only
  — a client-graph import is a hard error naming the importer) and
  `virtual:env/client` (the `VITE_`-prefixed client side; the prefix — or
  `envPrefix` — is enforced at config time).

  Validation is node-only and layered, against Vite's `loadEnv` merge of the
  `.env*` files with `process.env` winning — and the plugin folds the
  file-loaded vars into `process.env` itself, so templates drop the
  `process.env = { ...process.env, ...loadEnv(mode, root, '') }` boilerplate.
  In dev every failure renders the error overlay with a per-key report and
  `.env*`/schema edits revalidate live (surviving Vite's own
  restart-on-.env-change). In a build, `client` failures fail the build;
  `server` failures only warn (a build machine may not have the production
  secrets) and boot validation enforces them.

  Client values are baked as validated plain JSON — defaults applied,
  coercions done, zero validator bytes in a client bundle (the
  runtime-library alternative ships its validator to the browser; t3-env
  costs ~13 kB gz of zod) — that's what the `VITE_` prefix means. Server
  values are NOT baked anywhere: `virtual:env/server` reads `process.env` at
  server boot and validates through the user's own schema, imported into the
  server bundle only. Platform-injected vars that don't exist at build time
  work, secrets rotate without a rebuild, and no secret value exists in any
  dist artifact; an invalid server environment fails boot with the same
  per-key report. A client-build `generateBundle` scan additionally fails
  the build when a server var's literal value appears quoted in a client
  chunk, and a generated `solid-env.d.ts` (written next to the schema) types
  both virtual modules by inference from the user's own schema via the
  Standard Schema output type.

  Design credit: the feature's shape — the env.ts convention, the
  `virtual:env/*` names (kept identical deliberately), baked client values,
  the leak-scan heuristics — follows @vite-env/core by pyyupsk (MIT,
  https://github.com/pyyupsk/vite-env); the implementation is fresh on this
  plugin's machinery (Standard Schema as the only contract, no zod/jiti
  dependencies, consumer-based environment guarding, Vite's `runnerImport`
  for schema loading, runtime-read server values). Env is a start-mode feature:
  without `start` there is no env layer. See `examples/start-env`.

- 1272d95: Start-mode per-request app setup: `start.setup` points at a server-only module default-exporting `(event, App) => Component | void | Promise<Component | void>`, awaited by the generated server entry after the middleware chain dispatches to the page render and immediately before `renderToStream`. The seam routers with async per-request preparation need for SSR (create a router bound to the request, `await router.load()`, then render) — return a component to render in the app's place, or nothing to render `<App />` unchanged. The hook sees the same request event middleware decorated and runs inside the request scope. Zero-config entries are byte-identical without the option; authored server entries own `render()` already, so combining them is a config error.
- 8b36370: Breaking (start-mode config reshape): Start is now a mode of the plugin. The
  start-mode options move from the object form of `ssr` to a new `start` option
  (`start: true` is the zero-config spelling, pure sugar for `start: {}` —
  both mean the identical start mode with defaults), and `ssr` is a boolean
  again with one meaning everywhere — "is the app server-rendered".
  `ssr: { ... }` is now a config-time error with a migration message: write
  `start: { ... }` (or `start: true`) and set `ssr: true`. Options are
  otherwise unchanged (`start.document`, `start.entryServer`,
  `start.entryClient`, `start.middleware`, `start.external`, `start.app` for
  the root component); a bare `ssr: true` without `start` keeps the
  transform-only behavior, and `serverFunctions` stays orthogonal. The
  `SsrOptions` type is renamed to `StartOptions`.

  The reason for the split is the new **client start mode**: `start` without
  `ssr: true` serves the same conventions client-only. Dev streams the
  rendered document shell (without the app — history-fallback semantics,
  entry CSS inlined) and the generated client entry `render()`s the app into
  `document.body`; `vite build` prerenders the shell once through the built
  handler into `dist/client/index.html` (hashed entry script + entry CSS
  links) and emits a purely static `dist/client` — `dist/server` is kept only
  when `serverFunctions` needs it for the endpoint, and pages stay static.
  Client code compiles exactly like a plain SPA (`generate: 'dom'`,
  non-hydratable); only the document shell goes through the SSR transforms.
  Server-only options (`start.entryServer`, `start.external`, conventional
  `src/entry-server.*` files) are documented no-ops in client mode, so
  flipping a project between SPA and SSR is toggling the one `ssr` boolean —
  same App, same Document, same server functions (see `examples/start-client`,
  whose test flips the same app between the modes).

- 410c95f: Vitest always gets the client posture, regardless of the app's `ssr` flag: test-mode transforms compile non-hydratable (dom codegen under a DOM environment — nothing hydrates in a test), the `browser` export condition applies so solid resolves its client builds, and `test.environment` defaults to `jsdom` for server-rendered apps too. DOM component tests in an `ssr: true` app work without the `ssr: mode !== 'test'` workaround; explicit `test.environment: 'node'` still gets server codegen for `renderToString`-style tests.
- ad11469: Per-vitest-project server test posture: a project that sets `test.environment: 'node'` (or `'edge-runtime'`) explicitly gets the server posture end to end — server export conditions (`isServer` true), ssr codegen, and the framework inlined so the whole graph (request-event storage included) resolves into one server-build instance despite the workspace worker pool's root-derived native `--conditions`. Server-runtime unit suites (server functions, sessions) need no `deps.inline`/alias workarounds, and DOM (jsdom) and node projects coexist in one workspace.

## 3.0.0-next.23

### Patch Changes

- 906ef2a: update to solid 2.0.0-beta.32 and @dom-expressions/compiler 0.50.0-next.40 — `commitEventResponse` now ships in `@solidjs/web`, so the SSR start-mode handler imports it by name and the namespace-import fallback for pre-.40 runtimes is deleted; the solid floor moves to beta.32 accordingly
- b6af42f: SSR start mode closes the middleware early-return gap with the runtime's `commitEventResponse`: a middleware that answers without calling `next()` (an API handler) bypasses `createSSRResponse`, so its request-scope stub writes — cookies appended to `event.response.headers`, status — never reached the wire. The generated handler now applies `commitEventResponse(response, event)` unconditionally at the handler edge, strictly after the outermost middleware returns: headers stay mutable through the whole unwind, committed page responses pass through untouched (the fold is idempotent), and the inner per-path folds (`applyResponseStub` on raw `entry.render` Responses and server-function responses) collapse into the one edge fold.

  Until the next `@solidjs/web` repin ships `commitEventResponse` (TODO(.40-repin) in the codegen), the handler resolves it off a namespace import with a local fallback that preserves the previous partial fold semantics — a named import of a missing export would be fatal in ESM — so generated modules keep working against pre-.40 runtimes and upgrade to the runtime's fold (protocol-header denylist, committed-stub loudness) automatically at the repin.

- 65d6b51: Remove the unreleased `virtual:solid-manifest/client` module (and the `ClientAssetMap` type export). Its purpose was a route-CSS acquire/release lifecycle, which the head-management design has since ruled out: ambient, bundler-injected CSS is never lifecycle-managed — only head-registry-mounted stylesheets follow their owner — so the module had no remaining consumer. The server-side `virtual:solid-manifest` (SSR asset streaming) is untouched.
- 398044f: SSR start mode adopts the runtime's response-head lifecycle, gains fetch-style middleware, and serves `vite preview` (requires `@solidjs/web` > 2.0.0-beta.31 for `createRequestEvent` / `createSSRResponse` / `composeMiddleware`):

  - Every dispatch runs under a stub-backed request event (`createRequestEvent`) and page responses go through `createSSRResponse`: `httpStatus()` / `httpHeader()` writes land on the wire at shell flush, a pre-flush `Location` becomes a real 3xx redirect, and a post-flush one (streamed responses) falls back to a nonce-aware `<script>window.location=...</script>` tail. Raw `Response` results and server-function responses get uncommitted stub headers merged (set-cookie appended) so cookie/header writes made before they were produced still land.
  - `ssr.middleware`: a server-only module default-exporting one `(request, next) => Response | Promise<Response>` function or an array, composed in order. The chain fronts every dispatch path — page SSR, the server-function endpoint, dev, external-dev, production, preview — and runs inside the request-event scope, so `getRequestEvent()` works exactly as in app code; the endpoint shares the chain's event, so `locals` decoration is visible to server functions. Nothing hits the wire until the outermost middleware returns (post-`next()` header mutation works on streamed responses), and error middleware is a plain `try { await next() } catch`.
  - `vite build && vite preview` now works with no server file: `configurePreviewServer` serves `dist/client` statically through Vite's preview statics and dispatches everything else through the built handler — middleware and lifecycle included, HTML opted out of preview compression so streaming stays observable.
  - With `serverFunctions` enabled, the runnable-dev endpoint middleware now dispatches through the SSR handler (after pre-loading the referenced module), so one middleware chain and one request event front pages and server functions identically on every surface.

## 3.0.0-next.22

### Patch Changes

- d6fcfb9: update to solid 2.0.0-beta.30 and @dom-expressions/compiler 0.50.0-next.35 (the compiler's module-URL pass now also annotates `clientOnly(() => import("x"))` calls — third argument, options slot padded with `void 0` — so the server half can emit early modulepreload hints for browser-only modules; `resolveLazyModuleUrls` already resolves the placeholder position-independently)
- Update @dom-expressions/compiler to 0.50.0-next.37: the directive DCE now removes an import declaration whose surviving specifiers are all type-only after pruning (solid-start #2273), instead of leaving a bare server-module edge in the client bundle.
- 030fc89: Drop the `_$SC` bootstrap head-open splice. The runtime's serialized server-component references now self-bootstrap the registry (each hydration script's first reference carries it as an idempotent expression), so nothing needs to precede the data scripts — and the splice actively broke hydration: a script ahead of the authored `<head>` elements claims as the first walked child and drifts every positional claim after it (metas claimed as title, title as link), silently in production. Requires @dom-expressions/runtime 0.50.0-next.37 / @solidjs/web 2.0.0-beta.31.
- d1b2ed0: The generated SSR handler no longer crashes the server process when a client aborts a streaming response mid-flight. Enqueueing into a closed `ReadableStream` controller throws, and a streamed fragment can land seconds after the shell — an abort (page reload, navigation away) during that window took down the whole Node process with `ERR_INVALID_STATE`. Writes are now dropped once the stream closes or is cancelled.

## 3.0.0-next.21

### Patch Changes

- 6662c0f: update to solid 2.0.0-beta.29 and @dom-expressions/compiler 0.50.0-next.34 (the single-flight handler wiring imports `frameTransformFlightResult` from `@solidjs/web`, which first ships in that solid release)
- 1c51f54: Replace vite's `isRunnableDevEnvironment` with a duck-typed `runner`-presence check. Vite's helper is an `instanceof` test against the caller's own `vite` module, so when the plugin resolves to a different physical vite copy than the dev server's (workspace/`link:` installs), every environment failed the check and the SSR/dev middlewares silently stood down — serving markup without hydration wiring.
- c0fa77c: Install `frameTransformFlightResult` alongside `frameTransformResult` in the generated server-function handler module when `serverComponents` is on: mutations whose single-flight payload includes invalidated server-component markup answer with the frame stream as carrier (regions + envelope in one response). Only active when a router registers a `collectFlightData` hook.

  `frameTransformDirectResult` is now installed in the handler module too (previously only in the generated SSR entry): flight collection makes direct in-process calls during handler dispatch, and the transform brands their results with the call address the client matches showing boundaries against. Without it, a mutation dispatched before the SSR entry loads (dev restart with an open page) would silently degrade in-place morphs to minted boundaries.

## 3.0.0-next.20

### Patch Changes

- 528a7bb: Move the `solid:client-build-first` buildApp hook from `pre` to normal
  order, and make its post-order `/complete` companion defer to any other
  plugin that declares a non-pre `buildApp` hook of its own.

  Pre-order `buildApp` hooks are where host plugins do destructive
  preparation: nitro v3's `nitro:prepare` rm -rf's the output directory from
  a pre-order hook. Sorted at `pre`, our client build could run before that
  cleanup (hook order within `pre` follows plugin registration), so the
  client bundle and manifest it had just emitted were wiped, the subsequent
  server build baked in the manifest-less fallback, and the production build
  served 500s with no client assets — the `solid({ ssr })` + `nitro()`
  composition was broken out of the box.

  Normal order still satisfies the hook's original purpose (client before
  any server-first orchestrator): config-level `builder.buildApp`
  orchestrators (@cloudflare/vite-plugin builds workers before the client)
  are invoked by Vite only after all pre- and normal-order plugin hooks, and
  hook-based orchestrators (nitro's `nitro:main`, cloudflare's companion
  hook) declare post order. The `/complete` hook now also treats another
  plugin's non-pre `buildApp` hook as a claim on the app build even before
  it runs, instead of preempting a post-order orchestrator's staged build
  (nitro prerenders and copies public assets before its final server bundle,
  and knows which environments to skip). Plain `builder: {}` setups keep the
  reinstated build-everything fallback, unchanged.

  Covered by a new `examples/turnkey` e2e mode (builder-prepare) that builds against a
  nitro-shaped host: a pre-order output-wiping hook plus a post-order
  ssr-building orchestrator that skips already-built environments.

- 60ba309: Resolve relative filter globs against the Vite root instead of `process.cwd()`.

  The server-functions plugin's default include glob
  (`src/**/*.{jsx,tsx,ts,js,mjs,cjs}`) is relative, and `createFilter` resolved
  it against the invocation directory — so running `vite` from anywhere other
  than the project root silently skipped server-function compilation entirely
  (no transform, no registration). Both filters (the main plugin's
  `include`/`exclude` and `serverFunctions.filter`) are now created in
  `configResolved` with patterns resolved against `config.root`; user-provided
  relative patterns become root-relative too, and absolute patterns are
  unaffected.

## 3.0.0-next.19

### Patch Changes

- 83f7bb5: Two pieces hoisted from SolidStart so any host gets them plugin-side:

  - Dev-manifest HTTP bridge for isolated SSR runners. The dev asset resolver
    lives in the Vite process and is normally reached through a
    process-global registry; hosts that evaluate server modules in an
    isolated module runner (nitro's dev worker, workerd via
    @cloudflare/vite-plugin) can't see it, which broke lazy-route CSS and
    hydration preloads in dev. With `ssr` enabled the dev server now serves
    `GET /@vite-plugin-solid/dev-manifest?key=<module key>` (ResolvedAssets
    JSON, `null` for unresolvable keys), and the dev flavor of
    `virtual:solid-manifest` transparently falls back to fetching it when the
    registry has no entry for the root — the endpoint URL is baked in at
    module generation time from the live server's resolved origin, so
    isolated runners need zero host code. In-process consumers still
    short-circuit on the registry hit and never touch HTTP. Misses log loudly
    on both sides (registry miss / empty resolution on the serve side,
    non-OK responses and network failures on the fetch side) and resolve to
    `null`, keeping the runtime's own no-assets warning as the final
    catch-all.
  - Always-on `server-only` / `client-only` boundary marker modules:
    importing `server-only` from a module bundled for the client fails the
    build with an error naming the importer (and vice versa for
    `client-only`); the allowed environment resolves the marker to an empty
    module. Ambient type declarations ship at
    `vite-plugin-solid/boundary-modules`. The bare specifiers are claimed
    even when React's same-named npm packages are installed; the errors are
    prefixed `[vite-plugin-solid]`.

- 8386fb4: Let provider-owned SSR environments serve start-mode development requests without
  calling `ssrLoadModule`. Entry CSS and server functions are transported through
  the generated handler so isolated runtimes retain SSR styles and HMR support.

  Add `ssr.external` for integrations that also own the server build wiring.

## 3.0.0-next.18

### Patch Changes

- cdb19bf: update to solid 2.0.0-beta.28 and @dom-expressions/compiler 0.50.0-next.33
- 98fd955: Three extension points for composing the plugin with host environments
  (e.g. @cloudflare/vite-plugin) without giving up the start-mode option forms:

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
    anything, so plain `builder: {}` setups (start mode included) behave exactly
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

- 62d9a89: Send non-client server environments their own full-reload signal during hot
  updates. Environment-runner based servers now re-evaluate changed modules
  instead of serving stale SSR output, while client HMR remains unaffected.

## 3.0.0-next.17

### Patch Changes

- 178b9dc: update to solid 2.0.0-beta.26 and @dom-expressions/compiler 0.50.0-next.31
- 3b913f5: Inject the server-component bootstrap at the top of `<head>`, before the hydration data script. It was appended at `</head>`, but the generated document renders `<HydrationScript />` inside `<head>`, so the bootstrap always landed _after_ the payload it has to precede. The render plugin serializes a server component's placeholder as `self._$SC.r(id)`, so any document whose hydration payload carried a frame reference threw `Cannot read properties of undefined (reading 'r')` on boot — which aborted hydration, leaving the whole page inert: no client state, no interactivity, and no navigation, on an otherwise perfectly server-rendered document. The `examples/turnkey` app's own payload happens not to carry such a reference, so its "no page errors" check never caught this; the document assertion now verifies the ordering rather than mere presence.

## 3.0.0-next.16

### Minor Changes

- 91aea47: BREAKING: requires Vite 6+. The `vite` peer dependency is now
  `^6.0.0 || ^7.0.0 || ^8.0.0` and the legacy pre-environment-API code paths
  are gone: the plugin now always configures `resolve.conditions` and SSR
  `noExternal`/`external` per environment through `configEnvironment` (instead
  of the old top-level `resolve.conditions` / `ssr` config placement), and the
  start-mode SSR object form no longer needs a Vite-version guard. The `vite-3`,
  `vite-4` and `vite-5` examples were removed. If you are on Vite 3–5, stay on
  an earlier release of this plugin or upgrade Vite.
- 4bddb00: add `serverFunctions: { components: true }` (experimental): server components ride server functions with zero extra plugin config — the dev middleware and production handler serve component responses automatically, and SSR start mode's generated entries emit the document wiring (render plugin, bootstrap script, client `installServerComponents()` call)

### Patch Changes

- 4d68f9c: update to solid 2.0.0-beta.24 and @dom-expressions/compiler 0.50.0-next.29
- 2ca6a9e: update to solid 2.0.0-beta.25
- 7b20a0f: SSR start mode: dev responses now inline the entry graph's CSS, fixing the
  flash of unstyled content. The dev middleware walks the SSR module graph
  from the root entry (the app + document for generated entries, the authored
  server entry otherwise), compiles each transitively imported stylesheet
  through the client environment, and SSRs them as
  `<style data-asset data-vite-dev-id>` tags in `<head>` — the same shape the
  lazy-asset system emits, so Vite's client adopts them on startup (CSS HMR
  updates the adopted tag in place) and the dev style patch dedupes any
  late-injected twin. Previously entry CSS only arrived when the client entry
  JS executed, so server-painted markup flashed unstyled in dev; production
  was always fine (manifest-driven `<link rel="stylesheet">`).
- 1df46d6: Expose the `vite-plugin-solid/virtual-solid-manifest` ambient type
  declarations through a package `exports` subpath so
  `"types": ["vite-plugin-solid/virtual-solid-manifest"]` resolves under
  `moduleResolution: "bundler"` / `node16` too (previously only classic `node`
  resolution found the shipped `.d.ts`).

## 3.0.0-next.15

### Patch Changes

- 97d7ee8: update to solid 2.0.0-beta.22 and @dom-expressions/compiler 0.50.0-next.25

## 3.0.0-next.14

### Patch Changes

- b2b9979: update to solid 2.0.0-beta.21 and @dom-expressions/compiler 0.50.0-next.24
- 5828a6e: SSR start mode: the object form of the `ssr` option (even empty: `ssr: {}`)
  adds a serving layer on top of the SSR transforms so a plain Vite app gets
  streaming server-side rendering with zero wiring — no entry files, no
  index.html, no dev server script (requires Vite 6+; `ssr: true` keeps the
  transform-only behavior unchanged).

  - Dev: a middleware on the Vite dev server streams the rendered app for
    HTML-accepting GET requests through the SSR environment, scoping each
    request with `provideRequestEvent` and injecting the Vite client and the
    dev style patch into `<head>`; SSR errors flow (stack-fixed) to Vite's
    error page with the overlay. `vite` is the whole dev story.
  - Build: a plain `vite build` produces both bundles via the
    environments/builder API — client assets and manifest to `dist/client`,
    the server bundle to `dist/server/server.js` (`vite build --app` and the
    classic two-step `vite build` + `vite build --ssr` also work).
  - Prod: the server bundle's entry is the new `virtual:solid-ssr-handler`,
    whose `handleRequest(request)` export maps a web-standard `Request` to a
    streamed `Response` — adapter-agnostic, one line to mount on any server.
    Hashed client assets are resolved through `virtual:solid-manifest`.
  - Entries are conventional with escape hatches, resolved in order: explicit
    `ssr.entryServer` / `ssr.entryClient`; conventional `src/entry-server.*` /
    `src/entry-client.*` (the server entry exports
    `render(request?, context?)`; authored `/src/entry-client.tsx` script
    references are rewritten to the hashed asset in prod); else both entries
    are generated from a root component (`ssr.app`, default `src/App.*`)
    wrapped in a document shell (`ssr.document`, default `src/Document.*`,
    else a built-in one).
  - With `serverFunctions` enabled the two compose: the dev server-function
    middleware runs ahead of SSR, and the production `handleRequest` serves
    the endpoint before rendering.
  - Server-function registration robustness: the SSR build now merges the
    client build's persisted manifest at manifest load time as well, so
    builder-mode (single-invocation) builds keep registrations for functions
    only client code references.

## 3.0.0-next.13

### Patch Changes

- e372cc0: The native `@dom-expressions/compiler` is now the default JSX compiler (`compiler: 'native'`). `compiler: 'babel'` remains available as an escape hatch that switches ONLY the JSX transform back to `babel-preset-solid` — if native output differs from your expectations, set it and file an issue (the behavioral diff between the modes is the bug report). Platforms without a prebuilt native binary (e.g. StackBlitz WebContainers) automatically use the compiler's wasm32-wasi fallback; the compiler package is required in every mode.

  The `lazy()` module-URL pass and the solid-refresh HMR pass now run through native compiler passes (`transformLazy` / `transformRefresh`) in every mode, ahead of whichever JSX backend is selected, with sourcemaps chained across all passes. The plugin's own `lazy-module-url` Babel plugin is deleted (the placeholder format and its bundler-side resolution are unchanged), and supplying custom `babel` options in native mode reintroduces a Babel support pass hosting just those options.

  HMR wrappers in all modes now import the refresh runtime from the dev-only `solid-js/refresh` core entry, and the `solid-refresh` package dependency is removed entirely — this also fixes solid-refresh#85 (stale registrations resurrected after full-tree disposal on Solid 2.0) for what was previously the Babel path. Requires the solid-js release that ships the `solid-js/refresh` entry (landing with this release train).

- 4b9c1ea: The server-function `"use server"` directive transform now uses the native `transformDirectives` pass from `@dom-expressions/compiler` (Rust/Oxc) instead of the in-tree Babel implementation. Output is byte-compatible — same runtime ABI, `xxhash32(relative path)-<count>` function IDs, and manifest behavior — but the transform is faster and now reports invalid closure captures as compile-time errors: a server function referencing a binding from an intermediate enclosing scope (an enclosing function's local or parameter, a loop variable) fails the build naming the variable and its location instead of silently breaking at runtime. JSX compilation is unchanged (Babel by default, native opt-in); only the directive transform is native-always.

  Note: this requires `@dom-expressions/compiler` 0.50.0-next.23 or later — earlier releases do not include `transformDirectives`. The dependency is pinned accordingly.

- bde3e2b: More precise dead-code elimination after the `"use server"` client rewrite:

  - The shake is now scoped to bindings orphaned by the rewrite (names
    referenced from the replaced function bodies, cascading through removed
    declarations). Code that was already unreferenced before the transform —
    e.g. `const t = startTimer()` written for its side effect — is no longer
    deleted from client output.
  - Destructuring patterns are now shaken: `const { db } = createClient()`
    used only inside a server function is removed from the client build along
    with its now-unused imports, closing a server-code-leak hole. Array
    pattern elements become holes (or truncate the tail), rest elements and
    nested patterns cascade, and a declarator whose pattern empties is dropped
    entirely.
  - Modules containing a direct `eval(...)` call skip the shake (reference
    counts are unreliable there); the directive rewrite itself still applies,
    and a warning is logged in development mode.

- 25f0506: Built-in server functions: `serverFunctions: true` now gives a fully working
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

## 3.0.0-next.12

### Patch Changes

- 7b2a3ba: Follow the native compiler package rename: `@dom-expressions/jsx-compiler` is
  now `@dom-expressions/compiler` (the binary is growing beyond the JSX
  transform, so the name no longer singles out one pass). No option or behavior
  changes — `jsx: "native"` works exactly as before.

## 3.0.0-next.11

### Patch Changes

- 1914c40: Reclassify emitted lazy facade chunks even when their importers are eliminated from the final bundle. Emitted chunk references are now retained so lazy facades can be identified without relying on a surviving `dynamicImports` edge.
- bd2ed3f: Server functions now default their runtime to `@solidjs/web/server-functions`
  (requires the solid release that ships that subpath): the `runtime` option is
  optional and `serverFunctions: true` enables the compiler with the defaults.
  The package's export conditions resolve the client or server half per
  environment, so one specifier serves both builds — compiled output imports
  `registerServerReference` / `createServerReference` from it and the HTTP endpoint
  is one call to its `handleServerFunctionRequest` (see the reworked
  `examples/server-functions` fixture, which also round-trips the `respond()`
  helper). Custom runtimes still plug in through `runtime.{server,client}`.

## 3.0.0-next.10

### Patch Changes

- 583d731: Reclassify emitted lazy facade chunks by assigning `isEntry = false` instead of deleting the property. Under rolldown-vite (Vite 8), bundle chunks in `generateBundle` are proxies whose set trap syncs assignments back to the native bundle, while a delete is swallowed by the proxy's read cache — so the reclassification silently no-oped and downstream plugins (e.g. TanStack Start's manifest plugin) still saw every lazy facade chunk as an application entry, failing builds with "multiple entries detected".

## 3.0.0-next.9

### Patch Changes

- 7127c8b: Resolve the client build manifest from the client environment's actual output directory in builder-mode builds instead of assuming `dist/client`. Frameworks that relocate the client outDir (e.g. SolidStart's nitro plugin building to `.solid-start/client`) previously got the dev-shaped fallback manifest in their SSR bundle, breaking production asset resolution.

## 3.0.0-next.8

### Patch Changes

- 36428cb: Reclassify emitted lazy facade chunks as dynamic entries in the raw output bundle so downstream plugins do not mistake them for application entries.
- 3c33a9a: Dev SSR CSS collection and a client-side asset manifest:

  - In dev, `virtual:solid-manifest` now exports an asset resolver
    `{ resolve, resolveSync }` instead of a stub object. When server-side
    `lazy()` resolves a module, `resolve` walks Vite's SSR module graph and
    returns its transitively imported CSS as inline-style descriptors, so dev
    SSR streams fully styled markup (no FOUC) as `<style data-vite-dev-id>`
    tags that Vite's HMR client adopts; `resolveSync` answers with the dev js
    URL so islands keep a synchronous client-loadable `moduleUrl`. Requires
    `solid-js` ≥ 2.0.0-beta.18. A `devStylePatch` export (inline script for the
    document `<head>`) reconciles SSR'd style tags with Vite's client:
    it rewrites virtual-module ids to their null-byte form and removes the
    SSR'd twin when a late-streamed style arrives after Vite's client has
    seeded its registry — recommended for any streaming-SSR document in dev.
  - New `virtual:solid-manifest/client` module: a pruned map of dynamic-entry
    source keys (e.g. `src/routes/About.tsx`) to resolved client asset URLs
    `{ js, css }`, with entry-owned CSS excluded — for routers that manage
    route stylesheets and preloads around client-side navigation. Exports an
    empty map in dev where Vite owns the CSS lifecycle.
  - Build-side hooks (lazy facade-chunk emission, client manifest generation)
    now detect the client build through the per-environment `consumer` config
    when available. Builder-mode builds that run the client and ssr
    environments in one Vite process (e.g. SolidStart's nitro plugin) were
    misclassified by the process-wide `--ssr` flag, so dynamically imported
    modules folded into shared chunks lost their manifest entries and their
    CSS/preloads were dropped from SSR output.

- c3c49e8: `"use server"` server function compilation (experimental), hoisted from
  SolidStart 2.0 alpha's directive compiler. Enable it through the new
  `serverFunctions` option on the main plugin, or compose the standalone
  `serverFunctions(options)` export for full control over plugin ordering
  (e.g. relative to a file-system router). To support emitting the transform
  sub-plugins, `solid()` now returns `Plugin[]` instead of a single `Plugin` —
  transparent at the Vite config level, where plugin arrays flatten.

  - Both directive forms are supported: function-level (first statement of a
    function body) and module-level (every export becomes a server function).
    Server builds register the original function via `createServerReference`
    and reference it with `cloneServerReference`; client builds compile to
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

## 3.0.0-next.7

### Patch Changes

- f718828: Lazy-load the native JSX compiler so environments without native addon support can still use the default Babel compiler.

## 3.0.0-next.6

### Minor Changes

- 540f72e: Add an opt-in `compiler: "native"` JSX transform path powered by `@dom-expressions/jsx-compiler`.

### Patch Changes

- 5250437: Harden SSR asset resolution for `lazy()` modules.

  - Every dynamically imported project module in SSR-mode client builds is now emitted as an explicit facade chunk (`preserveSignature: "exports-only"`), so it always gets a manifest entry keyed by its source path and a stable `default` export — even when `manualChunks` or dual static/dynamic imports would otherwise fold it facade-less into a shared chunk. This also covers `import.meta.glob` targets that never pass through the `lazy()` moduleUrl transform.
  - Emitted facade chunks are reclassified from `isEntry` to `isDynamicEntry` in the virtual manifest so the runtime's entry-asset detection can't pick a lazy facade instead of the real client entry.
  - SSR transforms now append a `$$moduleUrl` export carrying the module's client-manifest key. Server-side `lazy()` (solid-js ≥ 2.0.0-beta.17) reads it off the resolved module when the callsite has no static import specifier — enabling asset resolution and hydration preloading for glob-based lazy routes. Client builds are untouched.

## 3.0.0-next.5

### Patch Changes

- ff60d98: Bump solid-refresh to 0.8.0-next.7

## 3.0.0-next.4

### Patch Changes

- 5ffcb1e: fix: preserve jsx for rolldown dep scan

## 3.0.0-next.3

### Patch Changes

- 824f72c: allow vite 8 in peerDeps

## 2.11.10

### Patch Changes

- b19050a: Fix SSR resolve.external being unconditionally applied in Vite 6+

## 2.11.9

### Patch Changes

- ce00b4b: Fix server-side testing with vitest/ssr

## 2.11.8

### Patch Changes

- 94431eb: add support for vite 7 in peerDeps
- ea5f791: Fix Vite 7+ compatibility.

## 2.11.7

### Patch Changes

- f58b288: add new configuration from dom-expressions

## 2.11.6

### Patch Changes

- 14da18d: Fix accessing the wrong user test configuration

## 2.11.5

### Patch Changes

- 57cb53a: Update path to type declaration

## 2.11.4

### Patch Changes

- ff66baf: Adjust path to type declaration

## 2.11.3

### Patch Changes

- d87159b: Fix duplicated test setupFiles in resolved vite config

## 2.11.2

### Patch Changes

- 5003976: handle empty query string
- 3da707e: Support query string in tsx/jsx files

## 2.11.1

### Patch Changes

- c5ddd03: Fix vite6 environment detection

## 2.11.0

### Minor Changes

- 8a6d81e: Add vite 6 compat

### Patch Changes

- 74c75d0: Support Vite 6's `resolve.conditions` breaking change

## 2.10.2

### Patch Changes

- e52d554: import solid as external to fix testing with npm
- 7500d78: update option types

## 2.10.1

### Patch Changes

- 1552678: emergency temporary revert of solid-refresh

## 2.10.0

### Minor Changes

- 6156811: add changesets, update to solid-refresh 0.7

<a name="2.3.0"></a>

## 2.3.0 (2022-07-14)

### Changed

- ⬆️ Update playground dependencies [[0438ab4](https://github.com/solidjs/vite-plugin-solid/commit/0438ab4a594d31b6cb15a57caf517060639b6de6)]
- ⬆️ Update dependencies (vite 3) [[17d5aef](https://github.com/solidjs/vite-plugin-solid/commit/17d5aef698836de5a2514056e5d622be3da711a9)]
- ⬆️ Update dependencies [[ac130ae](https://github.com/solidjs/vite-plugin-solid/commit/ac130ae5141591f292fa703573282c4f7286aeb1)]
- ⬆️ Update example folder dependencies [[093f738](https://github.com/solidjs/vite-plugin-solid/commit/093f7380708b22a660f63e3b91c3dd9d27ad5375)]
- ⬆️ Update dependencies [[0259ba6](https://github.com/solidjs/vite-plugin-solid/commit/0259ba6ad5ee9b46890804a900da9f6e71f92d84)]

### Removed

- 🔥 Remove legacy option &#x60;alias&#x60; [[4a432e8](https://github.com/solidjs/vite-plugin-solid/commit/4a432e80e66f527404db4bd224b689fb59866bf2)]

### Miscellaneous

- Merge pull request [#44](https://github.com/solidjs/vite-plugin-solid/issues/44) from vjoao/patch-1 [[88fd588](https://github.com/solidjs/vite-plugin-solid/commit/88fd5884ea6f509efabcb58c0ecf25d1e8fce628)]
- Add &#x27;universal&#x27; to compiler output [[75d66bb](https://github.com/solidjs/vite-plugin-solid/commit/75d66bb484fc3c4f9f282affb3d5258400b53619)]
- Merge pull request [#39](https://github.com/solidjs/vite-plugin-solid/issues/39) from btakita/issues/38 [[dce3536](https://github.com/solidjs/vite-plugin-solid/commit/dce35361935425d30627113c112b25abc5c8fe47)]
- Merge pull request [#37](https://github.com/solidjs/vite-plugin-solid/issues/37) from JoviDeCroock/patch-1 [[6c9c566](https://github.com/solidjs/vite-plugin-solid/commit/6c9c566a0352d9fe68de05b44ce6e70370ec00e3)]
- upgrade babel-preset-solid to 1.4.2 [[91e9511](https://github.com/solidjs/vite-plugin-solid/commit/91e9511429ab3e2e3ba3651819283d187775f0bb)]
- add types discoverability [[820c115](https://github.com/solidjs/vite-plugin-solid/commit/820c11580d8fe7ecb846616c20e395539a7664fc)]
- move &quot;vite&quot; and &quot;solid-js&quot; to peer dependencies [[dfd81c2](https://github.com/solidjs/vite-plugin-solid/commit/dfd81c2ab7b735846096562ea1ced248693b34a9)]
- Merge pull request [#36](https://github.com/solidjs/vite-plugin-solid/issues/36) from g-plane/peer-deps [[f896d4d](https://github.com/solidjs/vite-plugin-solid/commit/f896d4d306ccb20c3793c1ce741339d746d3966c)]
- remove ?. and bump version [[b310f93](https://github.com/solidjs/vite-plugin-solid/commit/b310f938f2a8a7fa7b7e516335dba1ef14c12b8e)]
- 📝 Update changelog [[b57f3e9](https://github.com/solidjs/vite-plugin-solid/commit/b57f3e9ed8c3048afe7d1f33bb85b4daefad2e03)]
- 📝 Update changelog [[55ed4f3](https://github.com/solidjs/vite-plugin-solid/commit/55ed4f3e39f0c15e12c897efdfcb6dc42ad756cc)]

<a name="2.2.5"></a>

## 2.2.5 (2022-01-26)

### Changed

- ⬆️ Update dependencies to latest [[0d429c2](https://github.com/solidjs/vite-plugin-solid/commit/0d429c2c59261f4bb23a62e5f9736eed113724bf)]
- 🎨 Rename poorly named variable [[d71ff9e](https://github.com/solidjs/vite-plugin-solid/commit/d71ff9ee486fa08a8a577f888b1b6902265ff826)]

### Miscellaneous

- Merge pull request [#29](https://github.com/solidjs/vite-plugin-solid/issues/29) from bgoscinski/master [[7443f0c](https://github.com/solidjs/vite-plugin-solid/commit/7443f0c5e790c4ba5c9539e0d96600ccf816dfab)]
- Merge branch &#x27;master&#x27; into master [[5788cc3](https://github.com/solidjs/vite-plugin-solid/commit/5788cc3098fca7d53a0bb770b516a42d670843b3)]
- Merge pull request [#27](https://github.com/solidjs/vite-plugin-solid/issues/27) from LXSMNSYC/patch-2 [[e7eb9dc](https://github.com/solidjs/vite-plugin-solid/commit/e7eb9dcc2202d93a5fc79d5fac012076a7c6ae69)]
- Update merge-anything to 5.0.0 [[8a5f9b5](https://github.com/solidjs/vite-plugin-solid/commit/8a5f9b51943f189f3147700c24748853a06c22d6)]
- revert temporary fix push people to newer vite with windows fix [[1fd98f6](https://github.com/solidjs/vite-plugin-solid/commit/1fd98f6ca566a54b9bc219f3613a382ee361515c)]
- Revert &quot;fix around vite plugin merging&quot; [[58dcda1](https://github.com/solidjs/vite-plugin-solid/commit/58dcda14c265122eb497d347b4d6429cf9401147)]
- Fix [#26](https://github.com/solidjs/vite-plugin-solid/issues/26) [[408367d](https://github.com/solidjs/vite-plugin-solid/commit/408367d96d4557fe6cac5d4970290a9b8d362372)]
- fix around vite plugin merging [[84c2568](https://github.com/solidjs/vite-plugin-solid/commit/84c25682361e94e112f2274910450291208eeee5)]
- bump [[2162537](https://github.com/solidjs/vite-plugin-solid/commit/2162537529f8a666cdef314fd67c48f1fac84d36)]
- Merge pull request [#25](https://github.com/solidjs/vite-plugin-solid/issues/25) from devinxi/nksaraf-patch-1 [[d61b98d](https://github.com/solidjs/vite-plugin-solid/commit/d61b98d77282b6c4c368c23d8c113c1c2b42f550)]
- Disable solid-refresh transform during SSR [[97debbe](https://github.com/solidjs/vite-plugin-solid/commit/97debbe5f820de1112f37a323ba420d9af8449a5)]
- update deps [[1494e5d](https://github.com/solidjs/vite-plugin-solid/commit/1494e5d28fb8ae923742b770972c7b12ae644730)]
- 📝 Adding &#x60;extensions&#x60; option to README [[d3ffe73](https://github.com/solidjs/vite-plugin-solid/commit/d3ffe73c63ff1af91254928820c742a1b15f4311)]
- 📝 Update changelog [[34095c3](https://github.com/solidjs/vite-plugin-solid/commit/34095c3dcc3cb2c7b867f957694d235c186d44e7)]

<a name="2.2.0"></a>

## 2.2.0 (2022-01-03)

### Added

- ✨ Add mdx example [[988e065](https://github.com/solidjs/vite-plugin-solid/commit/988e065a02bd9df742d5f56d896732d4593a2bdb)]

### Changed

- 🎨 Refactor code [[3a249f3](https://github.com/solidjs/vite-plugin-solid/commit/3a249f37001561ef66f8e8ab4eed82a42f52832e)]
- 🔧 Fix lock file [[0a14b3a](https://github.com/solidjs/vite-plugin-solid/commit/0a14b3ab5f00c77a9f28a9bf974f6a1f606b6465)]
- 🔧 Add pnpm as the default corepack package manager [[6ee5701](https://github.com/solidjs/vite-plugin-solid/commit/6ee5701a5d6702351afa08a95b87abbc0f403ee3)]
- ⬆️ Update playground dependencies [[3306823](https://github.com/solidjs/vite-plugin-solid/commit/3306823f453639e9af0844ba63b904717189f1fa)]
- ⬆️ Update dependencies [[5df5464](https://github.com/solidjs/vite-plugin-solid/commit/5df5464e7d3e53b9987e7df55134fba599dfa20c)]

### Removed

- 🔥 Remove deprecated code [[58f0623](https://github.com/solidjs/vite-plugin-solid/commit/58f0623506c588b1312793f281fe33e342eb6ec7)]

### Miscellaneous

- Merge pull request [#24](https://github.com/solidjs/vite-plugin-solid/issues/24) from high1/solid-mdx [[0416a1a](https://github.com/solidjs/vite-plugin-solid/commit/0416a1ac45c28967abc2ba8864f0b9ee2fd541b3)]
- Merge branch &#x27;master&#x27; into solid-mdx [[2d7d862](https://github.com/solidjs/vite-plugin-solid/commit/2d7d86269589f27e5577a90b400a64dc062db178)]
- Removed flags parsing [[41bd673](https://github.com/solidjs/vite-plugin-solid/commit/41bd67326cdc9425d48c6369b9f9b5b4363a5a7b)]
- Fixed undefined issue [[ea2724e](https://github.com/solidjs/vite-plugin-solid/commit/ea2724e5a336bd1a5147fc1e1d1f33dc027c7a74)]
- Updated the code [[2e07b2b](https://github.com/solidjs/vite-plugin-solid/commit/2e07b2bfcc822dc0343ae2d851ad1393288b6f2b)]
- Extensions option added [[e5b6389](https://github.com/solidjs/vite-plugin-solid/commit/e5b6389aa7fe579201ad6e4cbeec332441396040)]
- New banner [[34967e8](https://github.com/solidjs/vite-plugin-solid/commit/34967e82ea235c8dfe389f3bd91d440382835036)]
- Added new banner [[5a4e52f](https://github.com/solidjs/vite-plugin-solid/commit/5a4e52fa2099dea3bb67aeed705cb268999ce6a6)]
- bump deps [[9f8a623](https://github.com/solidjs/vite-plugin-solid/commit/9f8a6234cdb1ae290f2f9d434221abbff7c5a870)]
- update readme [[04ed442](https://github.com/solidjs/vite-plugin-solid/commit/04ed44299d88d34143cdad5f8764681035d2bb2e)]
- fix dev build in prod, stop adding transform refresh to node_modules [[2ea81e1](https://github.com/solidjs/vite-plugin-solid/commit/2ea81e1e6aac3e8a25eff3f0deae222d32d3f16c)]
- bump versions [[9395b64](https://github.com/solidjs/vite-plugin-solid/commit/9395b64632d04b860f89109998ae686087e59458)]
- 📝 Update changelog [[04f1081](https://github.com/solidjs/vite-plugin-solid/commit/04f1081853932b169c4ecbc960d56fa6f6fadfa6)]

<a name="2.1.2"></a>

## 2.1.2 (2021-11-04)

### Changed

- ⬆️ Update dependencies [[9938081](https://github.com/solidjs/vite-plugin-solid/commit/993808181e46bf7f92ab9fe5b1c908abaca9d395)]

### Fixed

- 🐛 Fix issues where the sourcemap wasn&#x27;t properly set (fix [#21](https://github.com/solidjs/vite-plugin-solid/issues/21)) [[d12159d](https://github.com/solidjs/vite-plugin-solid/commit/d12159d55f6a0fa16a72521219dc125ddb17a8c7)]

<a name="2.1.1"></a>

## 2.1.1 (2021-10-14)

### Changed

- 🔧 Prepare for upcomming vite update around ssr boolean [[b9b3f73](https://github.com/solidjs/vite-plugin-solid/commit/b9b3f73ab22bfc6e3451fbfc21441a06dc3acd9c)]
- ⬆️ Update dependencies [[5701543](https://github.com/solidjs/vite-plugin-solid/commit/5701543cec6a4921cb44dabf70cf6d3e43420fc0)]

### Miscellaneous

- 📝 Remove deprecated section [[942ede6](https://github.com/solidjs/vite-plugin-solid/commit/942ede6bc263903f492a9862f8905d18c5349127)]

<a name="2.1.0"></a>

## 2.1.0 (2021-10-02)

### Added

- ✨ Adding opt-in @babel/preset-typescript options [[fd746e6](https://github.com/solidjs/vite-plugin-solid/commit/fd746e6735c84ea51ddcd686b17be0ad7c91bd40)]

### Changed

- ⬆️ Update dependencies [[c6c96d5](https://github.com/solidjs/vite-plugin-solid/commit/c6c96d561fd6291e2756a877d2dfd903f98236a1)]

### Removed

- 🔥 Remove config merging (fix [#20](https://github.com/solidjs/vite-plugin-solid/issues/20)) [[124e7fa](https://github.com/solidjs/vite-plugin-solid/commit/124e7fa68d3b4270e45baed8be3a9d3cd4df1e81)]

### Miscellaneous

- Merge branch &#x27;master&#x27; of github.com:solidjs/vite-plugin-solid [[02aaa9f](https://github.com/solidjs/vite-plugin-solid/commit/02aaa9fd3e1f01d5e4f4c7444b7333fac9ab9c6f)]

<a name="2.0.2"></a>

## 2.0.2 (2021-08-27)

### Added

- ✨ Add directive to playground to make sure it works [[d506e83](https://github.com/solidjs/vite-plugin-solid/commit/d506e83a7d575b798e7cb4a3551022ee93f8309d)]

### Changed

- ⬆️ Update playground dependencies [[dfadfd7](https://github.com/solidjs/vite-plugin-solid/commit/dfadfd7ba3891f92486db76c7326a2e47d85af8b)]
- ⬆️ Update dependencies [[9a31397](https://github.com/solidjs/vite-plugin-solid/commit/9a31397f3218f93b81b907ad671e20a58d0ba171)]
- 🔧 Add &#x60;onlyRemoveTypeImports&#x60; on the TS preset [[7c9ad7e](https://github.com/solidjs/vite-plugin-solid/commit/7c9ad7edd65052f8a1f112786ebd7e7c529f8226)]
- 🔧 Fix playground after latest update [[18f8307](https://github.com/solidjs/vite-plugin-solid/commit/18f8307a6f874de3ea5356f98df1fea2a57e3efa)]
- ⬆️ Update to latest dependencies [[4856be5](https://github.com/solidjs/vite-plugin-solid/commit/4856be51360dd2be2104203fdc0c2fd55ffccc87)]

### Miscellaneous

- 📦 Fix lock file [[8740ad6](https://github.com/solidjs/vite-plugin-solid/commit/8740ad6fa4c6e20a6c26a788ea5ca27d9fd2a5cf)]
- 📝 Update readme [[6c18a33](https://github.com/solidjs/vite-plugin-solid/commit/6c18a3387b2160fdf0e8c703bc37c644b8ac4234)]
- Merge pull request [#17](https://github.com/solidjs/vite-plugin-solid/issues/17) from LXSMNSYC/patch-1 [[b03c61b](https://github.com/solidjs/vite-plugin-solid/commit/b03c61b15610f4acc498ecfecdb63299998b7c80)]
- Fix &#x60;solid-js&#x60; credits pointing to wrong url [[18d8dad](https://github.com/solidjs/vite-plugin-solid/commit/18d8dad1dba68a275535bb9e611f634770f82753)]
- Merge pull request [#16](https://github.com/solidjs/vite-plugin-solid/issues/16) from sprabowo/master [[17da93e](https://github.com/solidjs/vite-plugin-solid/commit/17da93e35e200e29e0869575aa75949b6ceab902)]
- fix: update repo in degit script [[b11624d](https://github.com/solidjs/vite-plugin-solid/commit/b11624db8a9652d04d165054858cbb1b35afe961)]
- Merge pull request [#15](https://github.com/solidjs/vite-plugin-solid/issues/15) from visualfanatic/patch-1 [[b2c64b7](https://github.com/solidjs/vite-plugin-solid/commit/b2c64b7390620ca1cfaea739db788724cfa12b3b)]
- Fix example Vite config [[198e27f](https://github.com/solidjs/vite-plugin-solid/commit/198e27fa8da8dabbbf25dd20e25c770aea73beaf)]
- 📝 Update changelog [[0c76257](https://github.com/solidjs/vite-plugin-solid/commit/0c76257ad2a864793fb48732168b216899d75a32)]

<a name="2.0.1"></a>

## 2.0.1 (2021-07-17)

### Changed

- 🔧 Externalize all dependencies [[0ec0692](https://github.com/solidjs/vite-plugin-solid/commit/0ec06926a7bb03d352583d07a84176c8dbe506cd)]
- ⬆️ Update dependencies [[f684995](https://github.com/solidjs/vite-plugin-solid/commit/f684995f378b3ad4055b0bbe93506ec70179c998)]
- ⬆️ Update solid-refresh [[b3180ae](https://github.com/solidjs/vite-plugin-solid/commit/b3180aeb89338bce2b8285df90b359812d6a294a)]

### Fixed

- 🐛 Fix solid-refresh import [[f24ef12](https://github.com/solidjs/vite-plugin-solid/commit/f24ef1200394b839d3c3cec0b89f83bf6e884fe2)]

<a name="2.0.0"></a>

## 2.0.0 (2021-06-28)

### Added

- ✨ Adding &#x60;babel-preset-solid&#x60; options from the vite plugin (fix [#13](https://github.com/solidjs/vite-plugin-solid/issues/13)) [[6759fee](https://github.com/solidjs/vite-plugin-solid/commit/6759fee6e732897c02918c21e6f35bd831a2999e)]

### Changed

- ⬆️ Update to solid 1.0 [[752e47e](https://github.com/solidjs/vite-plugin-solid/commit/752e47e73ef94109e3efd22dafea393edf702f6a)]

### Miscellaneous

- Merge remote-tracking branch &#x27;origin/master&#x27; [[66d8501](https://github.com/solidjs/vite-plugin-solid/commit/66d85018959eb6e1b6bb90f8e60c58e0ae26d912)]
- Merge branch &#x27;next&#x27; [[6d26d87](https://github.com/solidjs/vite-plugin-solid/commit/6d26d87ba10836347b913aca6cc3f993960076fd)]
- 📝 Update README [[337b022](https://github.com/solidjs/vite-plugin-solid/commit/337b0226143e6b525945d3d6252ccf732e0545f5)]
- 📝 Update readme for solid options [[4550cbf](https://github.com/solidjs/vite-plugin-solid/commit/4550cbf8bf4b5ba828273850396b30f98c4ae435)]

<a name="2.0.0-rc.4"></a>

## 2.0.0-rc.4 (2021-06-25)

### Added

- ✨ Adding new exports to dedupe / deps include [[7b7ca58](https://github.com/solidjs/vite-plugin-solid/commit/7b7ca583d4625e033b016f8b615f59d0fcd38460)]

### Changed

- ⬆️ Update dependencies to latest [[b36514b](https://github.com/solidjs/vite-plugin-solid/commit/b36514ba35fc248b01fadf4cd62fcf647fd841bb)]

<a name="2.0.0-rc.3"></a>

## 2.0.0-rc.3 (2021-06-19)

### Changed

- ⬆️ Update solid-refresh to latest [[3dd8081](https://github.com/solidjs/vite-plugin-solid/commit/3dd8081b353caf9552405c9253b4d86072cc75ed)]

### Miscellaneous

- 📝 Update readme for solid options [[66d35f0](https://github.com/solidjs/vite-plugin-solid/commit/66d35f0761023593dcb05557abad2ca59244cb22)]

<a name="2.0.0-rc.2"></a>

## 2.0.0-rc.2 (2021-06-06)

### Added

- ✨ Adding &#x60;babel-preset-solid&#x60; options from the vite plugin (fix [#13](https://github.com/solidjs/vite-plugin-solid/issues/13)) [[584d4e9](https://github.com/solidjs/vite-plugin-solid/commit/584d4e98c5b32affeeca625e92524e96a81f4844)]

### Changed

- ⬆️ Update to solid 1.0.0-rc.2 [[b4795bd](https://github.com/solidjs/vite-plugin-solid/commit/b4795bdd7f6dd688ea7bc3f7e63e0b934886bf14)]

### Miscellaneous

- 📝 Update changelog [[6389e88](https://github.com/solidjs/vite-plugin-solid/commit/6389e88f5472abf7cb39cf7e078bda64b05c78f6)]

<a name="1.9.0"></a>

## 1.9.0 (2021-06-06)

### Added

- ✨ Adding &#x60;babel-preset-solid&#x60; options from the vite plugin (fix [#13](https://github.com/solidjs/vite-plugin-solid/issues/13)) [[6759fee](https://github.com/solidjs/vite-plugin-solid/commit/6759fee6e732897c02918c21e6f35bd831a2999e)]

<a name="2.0.0-rc.1"></a>

## 2.0.0-rc.1 (2021-06-02)

### Changed

- ⬆️ Update to solid 1.0.0-rc.2 [[b4795bd](https://github.com/amoutonbrady/vite-plugin-solid/commit/b4795bdd7f6dd688ea7bc3f7e63e0b934886bf14)]

### Miscellaneous

- 📝 Update changelog [[c2bf813](https://github.com/amoutonbrady/vite-plugin-solid/commit/c2bf81380628b5696ca8c5a6f336d0e9613f5e35)]

<a name="1.8.0"></a>

## 1.8.0 (2021-05-13)

### Changed

- ⬆️ Update dependencies [[90b8a4c](https://github.com/amoutonbrady/vite-plugin-solid/commit/90b8a4c076ff235d23305e4b14985684c1efad2a)]

### Fixed

- ✏️ Fix typo in the readme regarding opting out of hmr (fix [#10](https://github.com/amoutonbrady/vite-plugin-solid/issues/10)) [[a3720a5](https://github.com/amoutonbrady/vite-plugin-solid/commit/a3720a563d3293b07e0cd9d9690afa91fee5d1d9)]
- 🐛 Make dev mode work in prod when set to true [[84a6eff](https://github.com/amoutonbrady/vite-plugin-solid/commit/84a6eff5de065800ff4be0962a8603ddc60f57ff)]

### Miscellaneous

- Merge pull request [#12](https://github.com/amoutonbrady/vite-plugin-solid/issues/12) from jorroll/monorepo-fix [[ba5d40c](https://github.com/amoutonbrady/vite-plugin-solid/commit/ba5d40c710bef282a88bffae48305abb83a27490)]
- fix: ensure &#x60;solid-js&#x60; is included in pre-bundle [[7098edc](https://github.com/amoutonbrady/vite-plugin-solid/commit/7098edcceff1af62328203f1dff6ed3edf0746d1)]
- Merge branch &#x27;master&#x27; of github.com:amoutonbrady/vite-plugin-solid [[c8a6cfc](https://github.com/amoutonbrady/vite-plugin-solid/commit/c8a6cfc4234f8b0ce48b4e4d200c43b53b21e49f)]
- 📝 Update changelog [[c7590ac](https://github.com/amoutonbrady/vite-plugin-solid/commit/c7590ac38fba0d6720d640fd75386f18122cba99)]
- Merge pull request [#11](https://github.com/amoutonbrady/vite-plugin-solid/issues/11) from jorroll/patch-1 [[25f0cea](https://github.com/amoutonbrady/vite-plugin-solid/commit/25f0ceacfe6f47cd026faa1811cc4ccfa84d18a3)]
- docs: add jsdoc comments for Options interface [[6f0cea9](https://github.com/amoutonbrady/vite-plugin-solid/commit/6f0cea9d76593d4dc59006b6599d01fd1042ff53)]
- fix: export this plugin&#x27;s options interface [[6d5a31a](https://github.com/amoutonbrady/vite-plugin-solid/commit/6d5a31ae6f1781d00e8fb53f16e730c04558462e)]

<a name="1.7.0"></a>

## 1.7.0 (2021-05-08)

### Changed

- ⬆️ Update dependnecies [[baf497a](https://github.com/amoutonbrady/vite-plugin-solid/commit/baf497afc3a144ecff904825e4e3640a58405d3c)]

### Miscellaneous

- 📝 Update changelog [[e2df01b](https://github.com/amoutonbrady/vite-plugin-solid/commit/e2df01b264b346fff8a2386a34f2c989244238dd)]

<a name="1.6.0"></a>

## 1.6.0 (2021-04-20)

### Changed

- ⬆️ Update dependencies [[1a2a2d6](https://github.com/amoutonbrady/vite-plugin-solid/commit/1a2a2d6b08abca585b8d9170250daf8541f3ec94)]

### Miscellaneous

- 📝 Adding requirements in the readme [#9](https://github.com/amoutonbrady/vite-plugin-solid/issues/9) [[eb5a019](https://github.com/amoutonbrady/vite-plugin-solid/commit/eb5a0194caec42158ed14d5cd2bd60bfacbf8759)]
- 📝 Update changelog [[94d199d](https://github.com/amoutonbrady/vite-plugin-solid/commit/94d199d2f87c13875e93ef8993672f9b5f070034)]

<a name="1.5.1"></a>

## 1.5.1 (2021-04-09)

### Changed

- ⚡ Bake merge-anything into the plugin [[ba1f655](https://github.com/amoutonbrady/vite-plugin-solid/commit/ba1f65562c6b45ea25ccb74ff690e052a4d0ec4e)]

<a name="1.5.0"></a>

## 1.5.0 (2021-04-02)

### Added

- ✨ Support &quot;type: module&quot; [[81b28a3](https://github.com/amoutonbrady/vite-plugin-solid/commit/81b28a3681a217ad3b674871133c672d0ef1e4bc)]
- ✨ Adding babel transform options [#7](https://github.com/amoutonbrady/vite-plugin-solid/issues/7) [[a70b7b7](https://github.com/amoutonbrady/vite-plugin-solid/commit/a70b7b707d7200bf1085501b4d74f159c6f7e09c)]

### Miscellaneous

- 📝 Update changelog [[296fa6c](https://github.com/amoutonbrady/vite-plugin-solid/commit/296fa6cbf63162315f2aea74c7038489bbe71d5d)]

<a name="1.4.0"></a>

## 1.4.0 (2021-04-01)

### Changed

- ⬆️ Update dependencies [[d065caa](https://github.com/amoutonbrady/vite-plugin-solid/commit/d065caa126cab3b7def1fe3f8c4b8e44df3808a4)]
- 🔧 Configure plugin target to current node fix [#8](https://github.com/amoutonbrady/vite-plugin-solid/issues/8) [[9a0a635](https://github.com/amoutonbrady/vite-plugin-solid/commit/9a0a635400c636ce012142c87456196d8bf74b5d)]

### Miscellaneous

- 📝 Update changelog [[ba5ced3](https://github.com/amoutonbrady/vite-plugin-solid/commit/ba5ced3928f7d059617ec56ac63dbdc52dd16eed)]

<a name="1.3.3"></a>

## 1.3.3 (2021-03-25)

### Changed

- ⬆️ Update dependencies [[7e9bec8](https://github.com/amoutonbrady/vite-plugin-solid/commit/7e9bec89b7d72600f38bb6fa60263e1832201d4f)]

### Fixed

- 🐛 Fix legacy alias warning [[847cdfe](https://github.com/amoutonbrady/vite-plugin-solid/commit/847cdfe5e7809be1b29817f382ca1c2659ab400d)]

<a name="1.3.2"></a>

## 1.3.2 (2021-03-19)

### Fixed

- 🐛 Force alias to be arrays to properly support config merging fix [#3](https://github.com/amoutonbrady/vite-plugin-solid/issues/3) [[9ffe0e5](https://github.com/amoutonbrady/vite-plugin-solid/commit/9ffe0e5989a36c8871a01f8aa767d8a7d57f089a)]

### Miscellaneous

- 📝 Updating changelog [[af0ab70](https://github.com/amoutonbrady/vite-plugin-solid/commit/af0ab7039950792ea1778955cc9eb4f46999aac7)]

<a name="1.3.1"></a>

## 1.3.1 (2021-03-15)

### Fixed

- 🐛 Merge arrays together&#x27; [[a2e7837](https://github.com/amoutonbrady/vite-plugin-solid/commit/a2e783716c8bb2e304e03a562cfcaaa0a2c3831f)]

### Miscellaneous

- 📝 Adding changelog [[2b2ade7](https://github.com/amoutonbrady/vite-plugin-solid/commit/2b2ade70c7d85237a47e403f4f41426505eeb1c5)]

<a name="1.3.0"></a>

## 1.3.0 (2021-03-09)

### Fixed

- 🐛 Fix HMR warning and remove peerDeps [[2a93fb5](https://github.com/amoutonbrady/vite-plugin-solid/commit/2a93fb59b39a98f1931e259bd2d72cc0dba4f161)]

<a name="1.2.4"></a>

## 1.2.4 (2021-03-08)

### Fixed

- 🐛 Fix deepmerge config issue + patch [[ea5225b](https://github.com/amoutonbrady/vite-plugin-solid/commit/ea5225b199972f1266e483723fd1ac1d3af40a4d)]

<a name="1.2.3"></a>

## 1.2.3 (2021-03-08)

### Changed

- ⬆️ Update dependencies [[079503b](https://github.com/amoutonbrady/vite-plugin-solid/commit/079503b2b60b2cd9dffa69ea74d182a4269c9760)]

### Miscellaneous

- 💩 Apply patch for the babel warning [[6e71e80](https://github.com/amoutonbrady/vite-plugin-solid/commit/6e71e80b79cbcc68499ca3aadf905b40bf59f739)]
- Merge pull request [#5](https://github.com/amoutonbrady/vite-plugin-solid/issues/5) from aminya/patch-1 [[79165cd](https://github.com/amoutonbrady/vite-plugin-solid/commit/79165cd9874cd1c0e7698e600508f6a01847f957)]
- fix start command in the readme [[85d08e2](https://github.com/amoutonbrady/vite-plugin-solid/commit/85d08e2eac1a310a7944e044650fe160ada64cbd)]
- Merge pull request [#4](https://github.com/amoutonbrady/vite-plugin-solid/issues/4) from maksimsemenov/respect-alias-in-user-config fixes [#3](https://github.com/amoutonbrady/vite-plugin-solid/issues/3) [[30e0442](https://github.com/amoutonbrady/vite-plugin-solid/commit/30e0442641d010d77131d985d006e73bba846b12)]
- Use map instead of reduce [[cb869a5](https://github.com/amoutonbrady/vite-plugin-solid/commit/cb869a52cee9662211b7153b10adadf629e9955b)]
- Resolve user alias config [[d775f6c](https://github.com/amoutonbrady/vite-plugin-solid/commit/d775f6c996a3c12a54e7af18492178f0fc832e1a)]

<a name="1.2.2"></a>

## 1.2.2 (2021-03-04)

### Changed

- ⬆️ Update dependencies (solid-refresh) [[3d74b58](https://github.com/amoutonbrady/vite-plugin-solid/commit/3d74b5841c8c0fa8e7c1827b41de7ba0f30a1a09)]

<a name="1.2.1"></a>

## 1.2.1 (2021-03-02)

### Changed

- ⬆️ Update dependencies [[272d553](https://github.com/amoutonbrady/vite-plugin-solid/commit/272d5537a7f9983e6a6c684965b97c0d6174fd57)]
- ⬆️ Update dependencies [[5baddad](https://github.com/amoutonbrady/vite-plugin-solid/commit/5baddad7ac366fd11b4e8dae184954cbfcd717a5)]

### Miscellaneous

- 📝 Update README for broken dependencies [[2dad73a](https://github.com/amoutonbrady/vite-plugin-solid/commit/2dad73a31a0b25c806ab62dbfc24f77b72d14912)]

<a name="1.2.0"></a>

## 1.2.0 (2021-02-22)

### Changed

- ⬆️ Update dependencies (and resolve solid export mapping) [[a7f5ee8](https://github.com/amoutonbrady/vite-plugin-solid/commit/a7f5ee898e2e4b5b29efe1c58fade08910bca7ef)]

<a name="1.1.3"></a>

## 1.1.3 (2021-02-22)

### Changed

- ⬆️ Update dependencies [[e55e8cd](https://github.com/amoutonbrady/vite-plugin-solid/commit/e55e8cdd564eed2ed2e537d53f3d70305650fa90)]

<a name="1.1.2"></a>

## 1.1.2 (2021-02-20)

### Fixed

- 🐛 Fix solid-refresh dependency [[71af74e](https://github.com/amoutonbrady/vite-plugin-solid/commit/71af74e0dce778d07bb07ab6952a0f10c7870bbe)]

<a name="1.1.1"></a>

## 1.1.1 (2021-02-20)

### Changed

- 🔧 Make solid-refresh a dependency instead of a devDependency [[c9a862b](https://github.com/amoutonbrady/vite-plugin-solid/commit/c9a862bb170583a505924b57e5a37321a2b7b5a8)]

### Miscellaneous

- 📝 Adding a demo gif [[85c8e6e](https://github.com/amoutonbrady/vite-plugin-solid/commit/85c8e6e9c1824e107ef8ff70d4d139d529797d5f)]

<a name="1.1.0"></a>

## 1.1.0 (2021-02-20)

### Added

- ✨ HMR is here! [[949f7e1](https://github.com/amoutonbrady/vite-plugin-solid/commit/949f7e1e3cddd8a4a71e0e53793ac6ba8c73321f)]

### Miscellaneous

- 📝 Update README for HMR [[8d48bb0](https://github.com/amoutonbrady/vite-plugin-solid/commit/8d48bb070b4c361537e95c77c95c099f2c5b04bb)]

<a name="1.0.0"></a>

## 1.0.0 (2021-02-17)

### Changed

- 🔧 Make sure the compiled output works [[00651db](https://github.com/amoutonbrady/vite-plugin-solid/commit/00651db6b0ab1ee8c1c44b7dffbd2562b5acf23b)]
- ♻️ Refactor a bit the plugin [[481f74b](https://github.com/amoutonbrady/vite-plugin-solid/commit/481f74bf89e0e54d16ee05bcbc4735cb66023366)]
- ⬆️ Update dependencies [[2af8a39](https://github.com/amoutonbrady/vite-plugin-solid/commit/2af8a39b46c14b341b98d4482436640b7f3a2eb0)]

### Miscellaneous

- 🏷️ Fixing some types &amp; indentation [[c9bb615](https://github.com/amoutonbrady/vite-plugin-solid/commit/c9bb61576da69ed60e0e1b3e35d44ce02350fcf3)]

<a name="0.9.1"></a>

## 0.9.1 (2021-02-13)

### Fixed

- 🐛 Fix SSR bug [[2eeefe9](https://github.com/amoutonbrady/vite-plugin-solid/commit/2eeefe93a7496b05ebc07d3026e66b789c8bb078)]

<a name="0.9.0"></a>

## 0.9.0 (2021-02-13)

### Added

- ✨ Adding hacky SSR [[720832a](https://github.com/amoutonbrady/vite-plugin-solid/commit/720832ac5dbc88dcc0bd4e7c4bbaac32b505e4c5)]

<a name="0.8.3"></a>

## 0.8.3 (2021-02-12)

### Added

- ✨ Aliasing solid-js for solid-js/dev in dev mode [[4ef6a4f](https://github.com/amoutonbrady/vite-plugin-solid/commit/4ef6a4f845a84e49ee91706387706c45ef928234)]

### Changed

- ⬆️ Update dependencies [[6c37c39](https://github.com/amoutonbrady/vite-plugin-solid/commit/6c37c39992998e38858a33c9da260f03b124e5a5)]

<a name="0.8.2"></a>

## 0.8.2 (2021-02-11)

### Removed

- 🔇 Remove logs [[54c2bb5](https://github.com/amoutonbrady/vite-plugin-solid/commit/54c2bb576d09a9858dcc4ffe52bef42603a927d7)]

<a name="0.8.1"></a>

## 0.8.1 (2021-02-11)

### Added

- ✅ Added extra check in the playground [[418d494](https://github.com/amoutonbrady/vite-plugin-solid/commit/418d494fc05077776a87d973e0828cb43741a935)]

### Changed

- ♻️ Simplified resolve rules [[55ef16b](https://github.com/amoutonbrady/vite-plugin-solid/commit/55ef16b09dcfc8a27647cf4b78d5e7edf11e498b)]
- ⬆️ Update dependencies [[e91b9a0](https://github.com/amoutonbrady/vite-plugin-solid/commit/e91b9a00f74546a634d3c5a1b9cef1ca97670a0a)]

<a name="0.8.0"></a>

## 0.8.0 (2021-02-04)

### Changed

- ⬆️ Update to solid 0.24 [[a87ea3f](https://github.com/amoutonbrady/vite-plugin-solid/commit/a87ea3fdef3e6c037ac2e41c5ce61b3f5add6bf9)]

<a name="0.7.1"></a>

## 0.7.1 (2021-01-30)

### Changed

- ⬆️ Update dependencies and minor fixes [[b37df18](https://github.com/amoutonbrady/vite-plugin-solid/commit/b37df186f13760a7a5c65454b3c33e2983137dd1)]

<a name="0.7.0"></a>

## 0.7.0 (2021-01-23)

### Changed

- 🔧 Adjusting the playground accordingly [[b723b26](https://github.com/amoutonbrady/vite-plugin-solid/commit/b723b2665b4c4672b3b2cc32a23d444c8ec0a331)]
- ♻️ Drastically simplify the plugin thanks to newer version of vite [[6fb5f87](https://github.com/amoutonbrady/vite-plugin-solid/commit/6fb5f87931e25c6c28fe853db8dddc56231aa774)]
- ⬆️ Update dependencies [[e9212ac](https://github.com/amoutonbrady/vite-plugin-solid/commit/e9212ac396e0ccd4a6c9f2a8250b71fc7bcd65f9)]
- ⬆️ Update dependencies [[6fbe325](https://github.com/amoutonbrady/vite-plugin-solid/commit/6fbe325c16a14ad431dbc707ee20143eedac8629)]
- ⬆️ Update dependencies [[0d25ea3](https://github.com/amoutonbrady/vite-plugin-solid/commit/0d25ea3d0b253a8b2ab4d95dc2b2056d2aa3968c)]

### Fixed

- ✏️ Fix typo [[0431ded](https://github.com/amoutonbrady/vite-plugin-solid/commit/0431ded78484d191b05f733c13ab1a9917aafd0b)]

<a name="0.6.0"></a>

## 0.6.0 (2021-01-04)

### Added

- ✨ Improved and document the code based on the vue jsx plugin [[531b698](https://github.com/amoutonbrady/vite-plugin-solid/commit/531b698f0636297ff441a703e80c0823127fcd80)]

<a name="0.5.0"></a>

## 0.5.0 (2021-01-02)

### Added

- ➕ Adding prettier [[91779f4](https://github.com/amoutonbrady/vite-plugin-solid/commit/91779f4a1b3a08723e1a0872ff363ec9cd57b38d)]
- ✨ Adding a testing playground [[75126cf](https://github.com/amoutonbrady/vite-plugin-solid/commit/75126cfb0944e206fb2b0c30880d1b03c1a25ac1)]
- ✨ Rewriting for vite 2 [[c82e81f](https://github.com/amoutonbrady/vite-plugin-solid/commit/c82e81fa135a6a621398883e7ceae1db8aa0a742)]

### Changed

- 🔧 Adding package check + publish hook [[499ac04](https://github.com/amoutonbrady/vite-plugin-solid/commit/499ac0440e6e35a89021fdc8c60a44b51ce7776e)]

### Fixed

- 🐛 Fix HMR issue 2 [[ab27288](https://github.com/amoutonbrady/vite-plugin-solid/commit/ab27288440e918f86d8b5462802693f624df139c)]

### Miscellaneous

- 📝 Adding disclaimer to readme [[99c2ef7](https://github.com/amoutonbrady/vite-plugin-solid/commit/99c2ef74854eacd18090dee16dbdfb2a5adc4f56)]
- 📝 Updating readme for vite 2 [[298205f](https://github.com/amoutonbrady/vite-plugin-solid/commit/298205f1037a665969cbc1a213d3042a6c0b4e91)]

<a name="0.4.1"></a>

## 0.4.1 (2020-11-23)

### Changed

- ⬆️ Update dependencies [[844ec9c](https://github.com/amoutonbrady/vite-plugin-solid/commit/844ec9c0799049241ce007d254ea3de128883070)]

### Fixed

- 🐛 Fix HMR issue [[e521e35](https://github.com/amoutonbrady/vite-plugin-solid/commit/e521e3516f05d143012033b86ef09ef49f57e32e)]

### Miscellaneous

- Merge pull request [#1](https://github.com/amoutonbrady/vite-plugin-solid/issues/1) from boogerlad/master [[1261690](https://github.com/amoutonbrady/vite-plugin-solid/commit/1261690d50bb47702f1c46d68ad0985ab8ab0642)]
- remove redundant textContent &#x3D; &#x27;&#x27; for HMR since as of solid 0.21.0 it&#x27;s handled by dom expressions [[2dfe316](https://github.com/amoutonbrady/vite-plugin-solid/commit/2dfe316f26930e99a9c3dcdc2b48c4e1f73b93e1)]

<a name="0.3.0"></a>

## 0.3.0 (2020-11-06)

### Changed

- ⬆️ Update dependencies for V1 [[ca68e35](https://github.com/amoutonbrady/vite-plugin-solid/commit/ca68e35c296d8aac46e243e9245337d3b6d52704)]
- ⬆️ Update to yarn 2 + solid 0.20 + clean up deps [[1106de0](https://github.com/amoutonbrady/vite-plugin-solid/commit/1106de0b5e7bd596f58a4c14bb2584a884b9aa62)]

### Miscellaneous

- Merge branch &#x27;release/0.1.1&#x27; into develop [[cb7698e](https://github.com/amoutonbrady/vite-plugin-solid/commit/cb7698e376a78e5f062c9c4f153cab4b9c97d7b0)]

<a name="0.1.1"></a>

## 0.1.1 (2020-08-13)

### Changed

- ⬆️ Update dependencies [[3e04f31](https://github.com/amoutonbrady/vite-plugin-solid/commit/3e04f3158c4ea0c8907c7d3fadea4a30b2bd9f4f)]

<a name="0.1.0"></a>

## 0.1.0 (2020-07-31)

### Added

- ✨ auto. hmr [[d96fcf2](https://github.com/amoutonbrady/vite-plugin-solid/commit/d96fcf2bfeb8e176dd79307dbd3f3e9dc62b2973)]

### Changed

- ⬆️ update dependencies [[bfa4da5](https://github.com/amoutonbrady/vite-plugin-solid/commit/bfa4da567115a5346e57adbe0406a9f5f83886bc)]

### Miscellaneous

- Merge branch &#x27;develop&#x27; into main [[fce4c49](https://github.com/amoutonbrady/vite-plugin-solid/commit/fce4c491d63f23d6c1ec51dccce23f29c4901415)]
- uh [[1dd1989](https://github.com/amoutonbrady/vite-plugin-solid/commit/1dd19895ee9653fd907aaad4a774721a7a0ad9f2)]
- Merge branch &#x27;release/0.0.4&#x27; into develop [[e7bd88d](https://github.com/amoutonbrady/vite-plugin-solid/commit/e7bd88d23e2c0e082b02a516725ec58a0710d4ba)]

<a name="0.0.4"></a>

## 0.0.4 (2020-07-21)

### Changed

- ⬆️ Update dependencies [[a1fd000](https://github.com/amoutonbrady/vite-plugin-solid/commit/a1fd00027cdf0ec67c366e8c5d12fb5dee493940)]
- 🔧 Try to fix missing dependencies [[340d82a](https://github.com/amoutonbrady/vite-plugin-solid/commit/340d82af3cd380ffb58bad754b76b107c94165ed)]

### Miscellaneous

- Merge branch &#x27;release/0.0.4&#x27; into main [[1855560](https://github.com/amoutonbrady/vite-plugin-solid/commit/18555608eeae7a96a4193d2c6e12d6f80b51ec78)]
- Merge remote-tracking branch &#x27;origin/develop&#x27; into develop [[b852754](https://github.com/amoutonbrady/vite-plugin-solid/commit/b85275415817d0b9402ac6634f8b0d23cd2fcb70)]
- 📝 Added a troubleshoooting section [[6532b51](https://github.com/amoutonbrady/vite-plugin-solid/commit/6532b51a59a0c248aa9c46e8f4703fb64ccf7002)]
- 📝 Update quickstart section to include the template [[17684c7](https://github.com/amoutonbrady/vite-plugin-solid/commit/17684c7c47cb2298408900d711b43a973c68bc5f)]
- Merge branch &#x27;develop&#x27; into main [[0f91383](https://github.com/amoutonbrady/vite-plugin-solid/commit/0f913830893275a88f0096c20838b1e1032a7f5f)]
- Merge branch &#x27;release/0.0.3&#x27; into main [[bb1c59b](https://github.com/amoutonbrady/vite-plugin-solid/commit/bb1c59bb1650240aa7d65cec4a9b53f1af46a24b)]
- Merge branch &#x27;release/0.0.2&#x27; into develop [[acd49de](https://github.com/amoutonbrady/vite-plugin-solid/commit/acd49de622408a348e04767563941d57a3f23c87)]

<a name="0.0.2"></a>

## 0.0.2 (2020-07-12)

### Changed

- 🔧 Export file to CJS [[fb5ed9c](https://github.com/amoutonbrady/vite-plugin-solid/commit/fb5ed9c0d08018f24f7fcf6041a3507adc3a3054)]

### Miscellaneous

- Merge branch &#x27;release/0.0.2&#x27; into main [[dda3822](https://github.com/amoutonbrady/vite-plugin-solid/commit/dda382268a9384028c1ca85c84c0ba6e25755433)]
- Merge branch &#x27;main&#x27; into develop [[19cd994](https://github.com/amoutonbrady/vite-plugin-solid/commit/19cd994f7c7fbb490bfe9dc251e7fe1012b29748)]
- 📦 Update package.json for release [[865fc11](https://github.com/amoutonbrady/vite-plugin-solid/commit/865fc119148115d30ffce3b2b45e75c768fe631d)]

<a name="0.0.1"></a>

## 0.0.1 (2020-07-12)

### Added

- 🎉 Initial commit [[004bebf](https://github.com/amoutonbrady/vite-plugin-solid/commit/004bebf08ad0f12b458dfbf6288113f5727fc987)]

### Miscellaneous

- 📝 Improve README [[2de0927](https://github.com/amoutonbrady/vite-plugin-solid/commit/2de09279b63096a9379523fab69860194fc79ed3)]
