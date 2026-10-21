---
'@solidjs/vite-plugin': patch
---

Two dev fixes for the server function manifest, which the generated handler imports when another plugin owns the SSR environment (for example `@cloudflare/vite-plugin`):

- The manifest no longer waits a fixed second on each load (#427). It reloads each time a new server function module is transformed, so startup, restarts and the first call to a new function each waited 1,000 ms. The debounce is only needed for builds, so dev now returns the current list. Each new module still invalidates the manifest before anything can call it.
- A deleted `"use server"` file, or one that no longer declares server functions, is now removed from the manifest. Before, the manifest kept importing it, and every request failed with `Failed to load url` until the dev server restarted.
