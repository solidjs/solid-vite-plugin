---
'@solidjs/vite-plugin': patch
---

SSR builds no longer export `$$moduleUrl` from entry chunks, so a Cloudflare Worker whose `main` is a project module starts again in workerd.
