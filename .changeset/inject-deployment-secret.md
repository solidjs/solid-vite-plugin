---
"@solidjs/vite-plugin": patch
---

Provide the deployment secret to server builds (solidjs/solid#3239): the generated server-function handler module now leads with `globalThis.__SOLID_SECRET__ ??= "<random-per-build>"`, giving the runtime's encrypted no-JS flash cookie a key with zero configuration. One value is generated per plugin instance, so a production build bakes a single secret into the emitted server chunk (shared by every instance of that deployment) and a dev session holds one for its lifetime. Server output only — the handler module is already hard-gated against client graphs — and an explicit `configureServerFunctionsServer({ secret })` still outranks it.
