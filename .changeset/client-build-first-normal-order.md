---
'@solidjs/vite-plugin': patch
---

Move the `solid:client-build-first` buildApp hook from `pre` to normal
order, and make its post-order `/complete` companion defer to any other
plugin that declares a non-pre `buildApp` hook of its own.

Pre-order `buildApp` hooks are where host plugins do destructive
preparation: nitro v3's `nitro:prepare` rm -rf's the output directory from
a pre-order hook. Sorted at `pre`, our client build could run before that
cleanup (hook order within `pre` follows plugin registration), so the
client bundle and manifest it had just emitted were wiped, the subsequent
server build baked in the manifest-less fallback, and the production build
served 500s with no client assets — the `solid({ ssr })` + `nitro()`
composition was broken out of the box.

Normal order still satisfies the hook's original purpose (client before
any server-first orchestrator): config-level `builder.buildApp`
orchestrators (@cloudflare/vite-plugin builds workers before the client)
are invoked by Vite only after all pre- and normal-order plugin hooks, and
hook-based orchestrators (nitro's `nitro:main`, cloudflare's companion
hook) declare post order. The `/complete` hook now also treats another
plugin's non-pre `buildApp` hook as a claim on the app build even before
it runs, instead of preempting a post-order orchestrator's staged build
(nitro prerenders and copies public assets before its final server bundle,
and knows which environments to skip). Plain `builder: {}` setups keep the
reinstated build-everything fallback, unchanged.

Covered by a new `examples/turnkey` e2e mode (builder-prepare) that builds against a
nitro-shaped host: a pre-order output-wiping hook plus a post-order
ssr-building orchestrator that skips already-built environments.
