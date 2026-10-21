---
'@solidjs/vite-plugin': patch
---

In dev, the server function manifest is now invalidated in every Vite environment, not just `client` and `ssr`. A host that imports the generated handler from a server environment of its own, such as Void's `void_worker` or a Cloudflare worker, kept a stale manifest before. A server function that only the client referenced then failed with "not part of the deployment" until the dev server restarted.
