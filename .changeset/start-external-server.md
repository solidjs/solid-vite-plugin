---
'@solidjs/vite-plugin': patch
---

Rename `start.external` to `start.externalServer`, so it no longer reads like Vite's `ssr.external` (dependency externalization): the option hands the whole server side to a host. The old key fails at config time with a message naming the replacement.
