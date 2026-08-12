---
'@solidjs/vite-plugin': patch
---

Boundary guard no longer aborts Vite's dependency scan. The dep scanner
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
