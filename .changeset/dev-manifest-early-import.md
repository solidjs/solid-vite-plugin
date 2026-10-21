---
'@solidjs/vite-plugin': patch
---

Lazy-route CSS no longer goes missing from dev SSR when a host imports `virtual:solid-manifest` before the dev server is listening (#414). Nitro's isolated runner does this at startup: the manifest had no origin to bake into the bridge URL yet, so it fell back to js-only resolution for the rest of the session. The bridge URL is now looked up on first use, without making the manifest import wait for the port, and a lookup made before the server listened is retried once it does.
