---
'@solidjs/vite-plugin': patch
---

Rename `start.errorBoundary` to `start.productionErrorBoundary`, since the boundary is only added in production builds. The old key fails at config time with a message naming the replacement.
