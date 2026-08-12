---
'@solidjs/vite-plugin': patch
---

Send non-client server environments their own full-reload signal during hot
updates. Environment-runner based servers now re-evaluate changed modules
instead of serving stale SSR output, while client HMR remains unaffected.
