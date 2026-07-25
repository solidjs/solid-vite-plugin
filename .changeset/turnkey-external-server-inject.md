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
- Dev entry CSS survives that handover: the styles are collected in the Vite
  process, where the module graph lives, and spliced into the streamed HTML
  before `</head>` as it passes back out. They were previously inlined by the
  dev HTML middleware, which no longer runs once something else serves, so dev
  SSR streamed unstyled markup and flashed on load. Collection is per-request,
  so HMR-edited CSS stays current.
