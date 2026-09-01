---
"@solidjs/vite-plugin": patch
---

Drop the retired `X-Server-Function-Id` header and `?id=` addressing fallback from the dev middleware's module-preload path. Addressing is path-only (`<endpoint>/<id>` and `<endpoint>/data/<id>`), matching the runtime's removal of its own transitional shims during the RC.
