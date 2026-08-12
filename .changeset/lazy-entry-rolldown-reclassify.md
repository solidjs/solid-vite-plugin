---
'@solidjs/vite-plugin': patch
---

Reclassify emitted lazy facade chunks by assigning `isEntry = false` instead of deleting the property. Under rolldown-vite (Vite 8), bundle chunks in `generateBundle` are proxies whose set trap syncs assignments back to the native bundle, while a delete is swallowed by the proxy's read cache — so the reclassification silently no-oped and downstream plugins (e.g. TanStack Start's manifest plugin) still saw every lazy facade chunk as an application entry, failing builds with "multiple entries detected".
