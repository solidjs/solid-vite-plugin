---
'@solidjs/vite-plugin': patch
---

Rename the plugin-managed application option from `start` to `app` and the
root component field from `start.app` to `app.root`. Explicit entries now use
`app.entries.client` and `app.entries.server`, and `errorBoundary` is renamed
to `productionErrorBoundary`. `StartOptions` is now `AppOptions`. The typed
`env` option is now top-level and can be used without app mode.
