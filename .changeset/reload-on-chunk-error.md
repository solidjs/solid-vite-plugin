---
'@solidjs/vite-plugin': patch
---

New `start.reloadOnChunkError` option, on by default. In a production build, the generated client entry reloads the page once when a code-split chunk fails to load, as it does when a deploy replaced the chunk while the page was open. A second failure within 10 seconds does not reload again. Set it to `false` to turn it off.
