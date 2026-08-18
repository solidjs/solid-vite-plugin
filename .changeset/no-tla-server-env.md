---
'@solidjs/vite-plugin': patch
---

`start.env`: the generated `virtual:env/server` module no longer contains
top-level await, removing the esnext-target deploy requirement. Boot
validation used to conditionally `await` each validator result (Standard
Schema allows `validate()` to return a Promise), which put a TLA in the
server env chunk whenever the schema had `server` keys — and any
downstream bundler with a non-esnext target refuses a TLA chunk outright
(Nitro's node-server preset is the one that bites in practice), forcing
deployments to override the build target to `esnext`. Boot validation is
now fully synchronous with identical semantics: same `process.env` read at
module init, same per-key report, same fail-loud-at-boot before any
importer's body runs, same frozen `env` export — and synchronous init is
the only shape that can keep the "validated before first use" guarantee,
since user server modules read `env.KEY` at their own top level (deferring
the await to request entry cannot cover module-init consumers). The
tradeoff is explicit: async validators (e.g. `z.string().refine(async
...)`) are no longer supported for `server` keys — they are rejected at
config/build time with the fix in the message (they could only ever have
failed at deploy boot otherwise), and boot backstops with the same report
for schemas whose async-ness only surfaces on real values. `client` keys
keep async support: their values are baked at build time, where the plugin
awaits. The start-env suite now asserts every built server chunk
transforms under esbuild target es2020 (which rejects TLA at parse time —
exactly the check a downstream bundler applies) so this cannot regress.
