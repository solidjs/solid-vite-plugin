---
'@solidjs/vite-plugin': patch
---

docs: "turnkey" is now "start mode" across user-facing language — the JSDoc on `ssr`/`start`/`serverFunctions` and on `StartOptions`/`ServerFunctionsOptions`, the READMEs, and the config-time error/warning strings all say start mode (SSR start mode / client start mode; the server-function dev middleware is "built-in", since it works without `start`). The components-without-start warning also names the right option (`start`, not `app`). Prose citing Solid 2.0 beta versions is reworded version-neutrally now that 2.0 is past beta — published dependency ranges are untouched.
