---
'@solidjs/vite-plugin': patch
---

Add a "Migrating from vite-plugin-solid 2.x" section to the README covering the package swap, the new Vite, Node.js and `@solidjs/web` requirements, the options whose behavior changed (`hot`, `dev`, `solid.moduleName`, `babel`, `include`/`exclude`, `ssr: false`) and the Vitest `jsdom` default that was dropped. The rename banner no longer says nothing else changes and links to it instead.
