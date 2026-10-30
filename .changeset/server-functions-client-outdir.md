---
'@solidjs/vite-plugin': patch
---

The server build now reads the client build's `.vite/solid-server-functions.json` from where the client build wrote it (or from the client environment's configured `outDir`) instead of always from `dist/client`. With a custom client `outDir`, client-only server functions now register and the build id check runs. Setting `serverFunctions.runtime` to the default runtime no longer turns the build id check off.
