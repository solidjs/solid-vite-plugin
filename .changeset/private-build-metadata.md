---
'@solidjs/vite-plugin': patch
---

Keep build metadata out of the client output when one process builds both environments. The server build reads Vite's manifest and the server-function data from memory, then the plugin removes the manifest it turned on (set `build.manifest` to keep it) and moves `.vite/solid-server-functions.json` to the server output, so hosts like Nitro that publish the client output no longer serve them.
