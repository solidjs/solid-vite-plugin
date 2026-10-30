---
'@solidjs/vite-plugin': patch
---

The server build now reads the client build's `.vite/solid-server-functions.json` from where the client build wrote it in the same process, then from the client environment's configured `outDir`, and only then from `dist/client`. With a custom client `outDir` (a single `vite build`, or `environments.client.build.outDir` set), client-only server functions now register and the build id check runs. Setting `serverFunctions.runtime` to the default runtime no longer turns the build id check off.
