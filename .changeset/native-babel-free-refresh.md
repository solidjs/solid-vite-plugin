---
'@solidjs/vite-plugin': patch
---

The native `@dom-expressions/compiler` is now the default JSX compiler (`compiler: 'native'`). `compiler: 'babel'` remains available as an escape hatch that switches ONLY the JSX transform back to `babel-preset-solid` — if native output differs from your expectations, set it and file an issue (the behavioral diff between the modes is the bug report). Platforms without a prebuilt native binary (e.g. StackBlitz WebContainers) automatically use the compiler's wasm32-wasi fallback; the compiler package is required in every mode.

The `lazy()` module-URL pass and the solid-refresh HMR pass now run through native compiler passes (`transformLazy` / `transformRefresh`) in every mode, ahead of whichever JSX backend is selected, with sourcemaps chained across all passes. The plugin's own `lazy-module-url` Babel plugin is deleted (the placeholder format and its bundler-side resolution are unchanged), and supplying custom `babel` options in native mode reintroduces a Babel support pass hosting just those options.

HMR wrappers in all modes now import the refresh runtime from the dev-only `solid-js/refresh` core entry, and the `solid-refresh` package dependency is removed entirely — this also fixes solid-refresh#85 (stale registrations resurrected after full-tree disposal on Solid 2.0) for what was previously the Babel path. Requires the solid-js release that ships the `solid-js/refresh` entry (landing with this release train).
