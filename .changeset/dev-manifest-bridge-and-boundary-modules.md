---
'vite-plugin-solid': patch
---

Two pieces hoisted from SolidStart so any host gets them plugin-side:

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
