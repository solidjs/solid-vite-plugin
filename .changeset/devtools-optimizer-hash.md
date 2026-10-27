---
'@solidjs/vite-plugin': patch
---

Fix `vite dev` breaking after a mid-session dependency re-optimization when the development toolbar is installed. The generated entries' `@solidjs/start-devtools` import reused the id captured when the toolbar was detected; in the client environment that id is the optimizer's pre-bundled URL, stamped with the browserHash of the pass that produced it. Any dependency discovered after the initial scan re-optimizes — the toolbar's chunks are re-emitted under new names and the hash moves on — and the frozen id kept the entry on the previous pass: its lazy chunks answered `504 Outdated Optimize Dep` and the stale bundle brought a second `solid-js` instance into the page (hydration key misses, `REACTIVITY_HALTED`). The import is now resolved afresh on every request, so it always follows the current optimizer pass.

The most common trigger is also removed: the agent diagnostics bridge (`@solidjs/diagnostics/browser` and `/protocol`) reaches the page through a virtual module the dependency scanner never crawls, so its first load discovered the two imports and forced exactly that re-optimize + reload. The diagnostics plugin now pre-bundles them up front whenever the surface is enabled.
