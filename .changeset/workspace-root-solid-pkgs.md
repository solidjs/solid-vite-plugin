---
'@solidjs/vite-plugin': patch
---

Packages with a `solid` export condition that are declared only in the workspace root's `package.json` are now inlined for projects in that workspace. Before, Vitest loaded them with Node and failed with `Unknown file extension ".jsx"` (#157).
