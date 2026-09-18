---
'vite-plugin-solid': patch
---

Vite 8's dependency scan no longer breaks on `.tsx` files (issue #262).
The plugin previously set `optimizeDeps.rolldownOptions.transform.jsx:
'preserve'` to stop Rolldown from injecting `react/jsx-dev-runtime`
imports during the scan — but the scanner re-parses the transformed
output as plain JS (`import.meta.glob` handling force-tags modules as
`js`), so any `.tsx` with JSX was a hard `PARSE_ERROR: Unexpected JSX
expression` that aborted the whole scan and skipped pre-bundling. The
scan transform now uses the classic JSX runtime, which lowers JSX to bare
`React.createElement` calls without injecting any import: the scan output
is never executed, it only exists so rolldown can walk the import graph,
so the undefined identifier is harmless. Backport of the fix already on
the 3.0.0-next line.
