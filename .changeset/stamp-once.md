---
'@solidjs/vite-plugin': patch
---

The build-id stamp is installed once, so an app's `prepareRequest` hook keeps running when both server-function runtime paths are in the client bundle (for example with `serverFunctions.components`).
