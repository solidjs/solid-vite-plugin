---
'@solidjs/vite-plugin': patch
---

Document the deployment contract provider plugins can rely on from 3.0: the `client` and `ssr` environments, the `ssr` environment's `index` handler entry with its `{ fetch }` and `handleRequest` exports, client-first build order, output locations, client-mode output, and the dev handover. A test builds an app through a stand-in provider that relies on it.
