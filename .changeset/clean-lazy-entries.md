---
'@solidjs/vite-plugin': patch
---

Reclassify emitted lazy facade chunks as dynamic entries in the raw output bundle so downstream plugins do not mistake them for application entries.
