---
'@solidjs/vite-plugin': patch
---

Server-function skew protection now holds when a host builds the app in one process and relocates the client output (nitro): once the same plugin instance built the client, the server build uses that build's id and discoveries from memory instead of reading `.vite/solid-server-functions.json`, which could be stale. Calls are also stamped when the app configures the client through `@solidjs/web/server-functions/client`; its `prepareRequest` used to drop the stamp.
