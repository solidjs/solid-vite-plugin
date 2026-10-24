---
'@solidjs/vite-plugin': patch
---

New `serverFunctions.serialization` option: a module whose default export sets the codec for server-function payloads (`plugins`, `disabledFeatures`, `depthLimit`, `serializeErrorStacks`). The plugin bundles it into both the client and the server, so custom types such as ORM ids round-trip without registering the codec twice. A bare array of plugins also works, so a SolidStart `serialization.plugins` module can be reused unchanged.
