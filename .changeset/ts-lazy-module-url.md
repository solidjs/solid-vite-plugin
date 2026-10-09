---
'@solidjs/vite-plugin': patch
---

Plain `.ts` and `.js` modules now get lazy callsite module URLs and, on the server, a `$$moduleUrl` export. Non-JSX files used to return before that pipeline, so a `routes.ts` of `lazy(() => import(...))` never told SSR which module to preload.
