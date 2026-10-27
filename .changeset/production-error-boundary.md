---
'@solidjs/vite-plugin': patch
---

Add a generic production error boundary to generated Start entries. It returns a 500 response for uncaught SSR errors and provides a fallback for uncaught client errors. Set `start.errorBoundary` to `false` when application middleware owns error handling.
