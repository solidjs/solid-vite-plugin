---
'@solidjs/vite-plugin': patch
---

Rename `start.node` to `start.nodeServer`: it emits a ready-to-run Node server (`dist/server/node.js`) and does not change the build target, which `node: true` could suggest. The old key fails at config time with a message naming the replacement.
