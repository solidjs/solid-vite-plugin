---
'@solidjs/vite-plugin': patch
---

Rename `serverFunctions.configure` to `serverFunctions.serverSetup`: it is a server-only module that runs once before any server-function call is handled, the same role `start.serverSetup` plays for the whole server. The old key fails at config time with a message naming the replacement.
