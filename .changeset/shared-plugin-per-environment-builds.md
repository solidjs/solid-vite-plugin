---
'@solidjs/vite-plugin': patch
---

Share one plugin instance across environment builds when the plugin comes from a config file. Vite's default builder evaluates the config file again for each environment, so the server build ran a fresh plugin instance that never saw the client build's manifest. It read `dist/client/.vite/manifest.json` from disk or fell back to the dev manifest (no client entry script or CSS on pages built for a provider that moves the output), and left `.vite/manifest.json` and `.vite/solid-server-functions.json` in the published client output. The plugins from `solidPlugin()` and the standalone `serverFunctions()` now set `sharedDuringBuild`, so Vite reuses one instance of them across environment builds, as `sharedPlugins: true` would.
