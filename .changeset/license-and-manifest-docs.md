---
'@solidjs/vite-plugin': patch
---

Housekeeping: add the MIT LICENSE file the `license` field has always declared but the repo never carried (#219), and document `virtual:solid-manifest` in the README — what it exports in dev (the live asset resolver) versus SSR builds (the baked client manifest with `_base`), and its role as the seam for frameworks doing their own asset gating (e.g. the TanStack Start integration).
