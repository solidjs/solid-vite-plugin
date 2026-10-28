---
'@solidjs/vite-plugin': patch
---

Add a "Migrating from vite-plugin-solid" section to the README covering the package swap, the new Vite, Node.js and `@solidjs/web` requirements, the options whose behavior changed (`hot`, `dev`, `solid.moduleName`, `babel`, `include`/`exclude`, `ssr: false`) and the Vitest `jsdom` default that was dropped. The rename banner no longer says nothing else changes; it says `vite-plugin-solid` stays on 2.x for Solid 1 and links to the new section.
