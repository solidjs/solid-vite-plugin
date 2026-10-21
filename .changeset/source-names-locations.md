---
"@solidjs/vite-plugin": patch
---

`sourceNames` gains a `locations` kind: a `file:line:col` next to every component, binding and primitive label — `createComponent(Home, props, "Home", "src/App.tsx:12:5")`, `createSignal(0, { name: "count", loc: "src/store.ts:3:22" })` — so diagnostics, `whyDidRun` chains and devtools point at the line that declared the node. On in dev; off for `observe` and production builds unless set (`{ locations: true }` or `sourceNames: true`), since those are shipped bundles. The plugin passes the resolved Vite root to both JSX compilers and to the primitives pass as `root`, so paths are root-relative and `http://localhost:5173/<path>` opens the file in the browser's sources panel. Requires the `@solidjs/compiler` release that takes the option; the plugin probes the installed compiler and, on an older one, keeps passing the names without locations (warning once when `locations` was asked for explicitly).
