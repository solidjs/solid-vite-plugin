---
"@solidjs/vite-plugin": patch
---

Read the file hash from the second id segment. Server-function ids are now identity-keyed `<name>-<hash>[-<ordinal>]` (solidjs/solid#3109) instead of positional `<hash>-<ordinal>`, so the dev middleware's id-to-module lookup takes the hash from `split('-')[1]` rather than the first segment.
