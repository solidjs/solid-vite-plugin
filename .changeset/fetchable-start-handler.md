---
'@solidjs/vite-plugin': patch
---

Start mode's generated request handler now default-exports a Fetchable
`{ fetch(request) }` object alongside its named `handleRequest` export.
Deployment integrations that follow the web-standard Fetchable convention
can consume the virtual handler or built server entry without a wrapper.
The `fetch` method intentionally ignores provider arguments after the request
instead of forwarding them as Solid handler options.

The normal `ssr` environment now exposes that handler as its `index` service
entry. Provider Vite plugins can adopt the same environment for development
and production without `start.external`, a custom source entry, or explicit
Rollup input. Standalone builds continue to emit `dist/server/server.js`.
