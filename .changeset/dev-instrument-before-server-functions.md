---
'@solidjs/vite-plugin': patch
---

Under `vite dev`, a server-function call that arrives before any page has loaded the server handler no longer loads the function's module ahead of `start.serverSetup`. The dev middleware imported the module first and the handler (which runs the server setup module first) second, so the module and everything it imports could load before instrumentation started. It now loads the handler first.
