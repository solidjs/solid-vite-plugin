---
'@solidjs/vite-plugin': patch
---

Vite 8's dependency scan no longer breaks on `.tsx` files (issue #262).
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
