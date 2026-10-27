---
'@solidjs/vite-plugin': patch
---

Compile modules whose id has the extension after the query, such as unplugin-icons' `~icons/mdi/folder?width=2em.tsx`. These were left to Vite's default JSX transform, which produced React code (#206). Custom `extensions` are now also matched when the query contains a dot.
