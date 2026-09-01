---
'@solidjs/vite-plugin': patch
---

Auto-enable the agent diagnostics surface (dev serve only) when `@solidjs/diagnostics` is installed in the app — installing the dev dependency is now the whole setup. The `diagnostics` option becomes an override: `true` forces it on (erroring if the package is missing), `false` opts out entirely, omitted auto-detects. Start mode's generated/authored client entries follow the same detection for the bridge import.
