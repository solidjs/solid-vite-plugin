---
'@solidjs/vite-plugin': patch
---

Production SSR links a route's built CSS and chunks again when the host gives each environment its own plugin instance (#525). Vite's default builder resolves the config again for every environment, so the server build's instance never saw the client build and looked for the manifest only in `dist/client`. With `@cloudflare/vite-plugin` 2.0, which writes the client to `.cloudflare/output/...`, it found nothing and baked in the development resolver, which returns source paths and no CSS. The server build now reads the manifest from the client environment's configured `outDir` first. A client build also no longer remembers lazy chunks from an earlier build by the same instance, so the client rebuild that Cloudflare runs after the worker writes the same files instead of a second copy of the app.
