---
'@solidjs/vite-plugin': patch
---

The dependency scanner settings now reach every environment, not just `client` (#387). Vite seeds only the `client` environment from the top-level `optimizeDeps`, so an `ssr` (or other server) environment with discovery turned back on — as `@cloudflare/vite-plugin` does for workerd SSR — scanned Solid TSX with Rolldown's default React automatic runtime. The scan failed on an unresolvable `react/jsx-dev-runtime` and pre-bundling was skipped for that environment, which showed up as duplicate Solid instances in the app. `configEnvironment` now gives non-client environments the classic scanner JSX runtime (unless the app set its own per-environment `transform.jsx`), the `.tsrx` extension, and the tsrx scan plugin.
