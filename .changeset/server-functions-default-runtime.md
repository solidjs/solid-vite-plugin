---
'@solidjs/vite-plugin': patch
---

Server functions now default their runtime to `@solidjs/web/server-functions`
(requires the solid release that ships that subpath): the `runtime` option is
optional and `serverFunctions: true` enables the compiler with the defaults.
The package's export conditions resolve the client or server half per
environment, so one specifier serves both builds — compiled output imports
`registerServerReference` / `createServerReference` from it and the HTTP endpoint
is one call to its `handleServerFunctionRequest` (see the reworked
`examples/server-functions` fixture, which also round-trips the `respond()`
helper). Custom runtimes still plug in through `runtime.{server,client}`.
