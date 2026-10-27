---
'@solidjs/vite-plugin': patch
---

Diagnostics auto-detection now requires the app to declare `@solidjs/diagnostics` in its own package.json (presence in ancestor node_modules surprise-enabled the surface for monorepo fixture apps), and the surface never activates in test mode (vitest browser mode runs a dev serve and was getting the bridge injected into test pages).
