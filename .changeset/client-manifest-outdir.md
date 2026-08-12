---
'@solidjs/vite-plugin': patch
---

Resolve the client build manifest from the client environment's actual output directory in builder-mode builds instead of assuming `dist/client`. Frameworks that relocate the client outDir (e.g. SolidStart's nitro plugin building to `.solid-start/client`) previously got the dev-shaped fallback manifest in their SSR bundle, breaking production asset resolution.
