---
'@solidjs/vite-plugin': patch
---

Rename the env modules `virtual:env/server` and `virtual:env/client` to `virtual:solid-env/server` and `virtual:solid-env/client`, matching the plugin's other `virtual:solid-*` modules. Importing an old ID fails with a message naming the new one, and the generated `solid-env.d.ts` declares the new IDs.
