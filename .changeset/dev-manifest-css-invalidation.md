---
'@solidjs/vite-plugin': patch
---

Invalidate the dev manifest's CSS cache in isolated SSR runners after file changes. Subsequent server responses include the updated styles before hydration. Responses started before invalidation cannot restore old cache entries or remove newer pending requests.
