---
'@solidjs/vite-plugin': patch
---

Add the `StartServerRenderSetup` and `StartServerRenderContext` types (a `start.serverRenderSetup` module's default export, and the context an authored server entry's `render` receives), and type the options of `handleServerFunctionRequest` and `handleRequest`'s `serverFunctions` with the runtime's `HandleServerFunctionOptions`, so a misspelled option no longer type-checks. The README now documents the client build's `.vite/solid-server-functions.json` (`PersistedServerFunctionManifest`), and option docs that still mentioned solid-refresh or `@solidjs/babel-plugin` are corrected.
