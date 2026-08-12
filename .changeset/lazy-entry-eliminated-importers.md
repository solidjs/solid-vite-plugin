---
'@solidjs/vite-plugin': patch
---

Reclassify emitted lazy facade chunks even when their importers are eliminated from the final bundle. Emitted chunk references are now retained so lazy facades can be identified without relying on a surviving `dynamicImports` edge.
