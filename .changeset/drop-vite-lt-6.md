---
'@solidjs/vite-plugin': minor
---

BREAKING: requires Vite 6+. The `vite` peer dependency is now
`^6.0.0 || ^7.0.0 || ^8.0.0` and the legacy pre-environment-API code paths
are gone: the plugin now always configures `resolve.conditions` and SSR
`noExternal`/`external` per environment through `configEnvironment` (instead
of the old top-level `resolve.conditions` / `ssr` config placement), and the
turnkey SSR object form no longer needs a Vite-version guard. The `vite-3`,
`vite-4` and `vite-5` examples were removed. If you are on Vite 3–5, stay on
an earlier release of this plugin or upgrade Vite.
