---
'@solidjs/vite-plugin': patch
---

The `server-only`/`client-only` boundary guard no longer crashes when
`this.environment` isn't available on resolve hooks, and now detects the
target environment through the same `getEnvironmentConsumer` helper used
by the rest of the plugin, falling back to the resolve hook's `ssr` flag
when the environment is absent.
