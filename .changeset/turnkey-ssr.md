---
'@solidjs/vite-plugin': patch
---

Turnkey SSR: the object form of the `ssr` option (even empty: `ssr: {}`)
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
