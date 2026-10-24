---
'@solidjs/vite-plugin': patch
---

New `start.earlyHints` option, off by default. A production SSR build sends the client entry's scripts and stylesheets as `103 Early Hints` before a page renders, so the browser can start downloading them sooner. The `start.node` server and `vite preview` send a real `103`, other hosts can pass an `earlyHints` callback to `handleRequest`, and otherwise the links are added as `Link` headers on the page response.
