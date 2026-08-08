---
'vite-plugin-solid': patch
---

The dev asset resolver now caches per module key and answers synchronously once a key's assets are known (in-flight walks are deduped; any watcher event drops the cache so dev CSS stays fresh). Server-side `lazy()` re-requests a module's assets on every retry of a suspended render pass — the router's nested outlets re-create the component per retry — and an always-async resolver suspends every retry on a brand-new promise, so the pass never converges: any nested route hung `vite dev`, or overflowed the render stack (one resume closure nests per cycle) and the escaped rejection killed the dev server. The build manifest never looped because it answers synchronously; dev now matches it after the first resolution. The HTTP bridge resolver for isolated SSR runners (nitro dev worker, workerd) gets the same convergence cache.
