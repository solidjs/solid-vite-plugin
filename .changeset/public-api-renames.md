---
'@solidjs/vite-plugin': patch
---

Rename the types entry `@solidjs/vite-plugin/virtual-solid-manifest` to `@solidjs/vite-plugin/virtual-modules` (it declares every virtual module the plugin serves) and `css.filter` to `css.devInline` (it picks which module graphs dev SSR crawls for the CSS it inlines). Remove `serverFunctions.manifest`: the module id is always `virtual:solid-server-function-manifest`. The old option names fail at config time with a message naming the replacement.
