---
'@solidjs/vite-plugin': patch
---

Start devtools are no longer enabled when `@solidjs/start-devtools` is not installed. Detection falls back to resolving the package from the plugin's own file (for pnpm-isolated installs where it is only a dependency of the plugin), but the package is declared an optional peer dependency of the plugin, so when it is absent Vite answers that resolution with its `__vite-optional-peer-dep:` stub instead of `null`. The plugin took the stub as a successful resolution, wrapped the generated client entry in `DevToolbar`, and the browser failed with `The requested module '/@id/__vite-optional-peer-dep:@solidjs/start-devtools:@solidjs/vite-plugin' does not provide an export named 'DevToolbar'`. The stub is now treated as "not installed".
