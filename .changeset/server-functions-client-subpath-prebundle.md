---
'@solidjs/vite-plugin': patch
---

With `serverFunctions` on, the dev server now also pre-bundles `@solidjs/web/server-functions/client` (#428):

- `@solidjs/web/frames`, used with `components: true`, imports the client runtime by that subpath.
- `@solidjs/web/server-functions/rich-args` imports it by that subpath too.

When the app listed `@solidjs/web` in `optimizeDeps.exclude`, both loaded a second copy of the client from node_modules. Server components that mounted after boot resolved to `undefined`, and `enableRichArguments()` configured a client that compiled server functions did not use.

A custom `runtime.client` is unchanged.
