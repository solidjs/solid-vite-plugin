---
'@solidjs/vite-plugin': patch
---

New `start.clientSetup` option: a client module the generated client entry runs before it hydrates or mounts the app. Use it to install a server-function transport wrapper, a `vite:preloadError` listener, or an error reporter before the first render, without writing your own `entry-client` / `entry-server` pair. The module may use top-level `await`, and `hydrate()` / `render()` waits for it. Combining it with an authored `entry-client` is a config error.

The start options list in the README now also names `instrument`.
