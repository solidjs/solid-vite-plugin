---
'@solidjs/vite-plugin': patch
---

Use Vite hook filters on the plugin's `transform`, `resolveId` and `load` hooks, so under Rolldown the JavaScript side only runs for modules a hook can act on; a dependency's plain scripts only reach the transform when they mention `solid-js`. In a 2,100-module start-mode build, this cut build time by about 8% with identical output.
