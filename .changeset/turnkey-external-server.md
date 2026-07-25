---
'vite-plugin-solid': patch
---

Turnkey SSR: let an external server own serving and the build.

- Configuring `environments.ssr.build.rollupOptions.input` now signals that a
  server integration (nitro, a Cloudflare worker, a custom harness) owns the
  server. Turnkey still resolves/generates the entries, emits
  `virtual:solid-ssr-handler` and configures the client manifest, but stops
  overriding the ssr build input, the `dist/*` outDirs and the `builder` flag,
  and stops registering its dev HTML middleware. Previously the ssr input was
  overwritten with the handler unconditionally, so the integration was left
  with no server entry of its own — with nitro that means no renderer route is
  registered and every page 404s in preview.
- The entry graph's dev stylesheets are now also exposed on a dev-only
  endpoint, and the generated handler fetches it when the caller passes no
  `devHead`. Entry CSS is collected in the dev HTML middleware, which never
  runs when something else serves, and the handler typically runs in another
  runtime (a dev worker, workerd) that can reach neither Vite's module graph
  nor the `globalThis` resolver registry — so dev SSR streamed unstyled markup
  and flashed on load. Collection stays per-request, so HMR-edited CSS is
  current.
