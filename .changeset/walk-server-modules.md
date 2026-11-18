---
'@solidjs/vite-plugin': patch
---

With `serverFunctions.components`, a module that only the server-component stylesheet walk loads no longer fails the client build when it imports `server-only`, and its dynamic imports are no longer emitted as client chunks.
