---
'@solidjs/vite-plugin': patch
---

Turnkey typed env (`start.env`): first-party typed, validated environment
variables for both turnkey modes. A schema file at the project root —
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
for schema loading, runtime-read server values). Env is a turnkey feature:
without `start` there is no env layer. See `examples/start-env`.
