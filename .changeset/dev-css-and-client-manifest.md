---
'@solidjs/vite-plugin': patch
---

Dev SSR CSS collection and a client-side asset manifest:

- In dev, `virtual:solid-manifest` now exports an asset resolver
  `{ resolve, resolveSync }` instead of a stub object. When server-side
  `lazy()` resolves a module, `resolve` walks Vite's SSR module graph and
  returns its transitively imported CSS as inline-style descriptors, so dev
  SSR streams fully styled markup (no FOUC) as `<style data-vite-dev-id>`
  tags that Vite's HMR client adopts; `resolveSync` answers with the dev js
  URL so islands keep a synchronous client-loadable `moduleUrl`. Requires
  `solid-js` ≥ 2.0.0-beta.18. A `devStylePatch` export (inline script for the
  document `<head>`) reconciles SSR'd style tags with Vite's client:
  it rewrites virtual-module ids to their null-byte form and removes the
  SSR'd twin when a late-streamed style arrives after Vite's client has
  seeded its registry — recommended for any streaming-SSR document in dev.
- Build-side hooks (lazy facade-chunk emission, manifest classification)
  now detect the client build through the per-environment `consumer` config
  when available. Builder-mode builds that run the client and ssr
  environments in one Vite process (e.g. SolidStart's nitro plugin) were
  misclassified by the process-wide `--ssr` flag, so dynamically imported
  modules folded into shared chunks lost their manifest entries and their
  CSS/preloads were dropped from SSR output.
