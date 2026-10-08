---
'@solidjs/vite-plugin': patch
---

The build now defines `__SOLID_SERVER_COMPONENTS__` so libraries can drop server-component-only client code (#396). The value is `"true"` when `serverFunctions.components` is set (including `'external'`) and `"false"` otherwise, and it is always defined — an absent identifier cannot be eliminated. It is set on Vite's `define` (build, and dev source via `/@vite/env`) and on every environment's `optimizeDeps.rolldownOptions.transform.define`, because the optimizer ignores top-level `define` and only the `client` environment inherits top-level `optimizeDeps`. A user-provided `define` value wins, and so does a value already set on that environment's optimizer.
