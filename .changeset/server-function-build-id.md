---
'@solidjs/vite-plugin': patch
---

Production builds now stamp server function calls with a build id (solidjs/solid#4215). The client build adds an `X-Server-Function-Build` header to every non-GET call, and the server build configures the runtime with the same id, read from the client build's `.vite/solid-server-functions.json`. A tab still running the previous deploy now gets a 409 (`unknownFunction: true`) for a function whose id survived the deploy, instead of running it with arguments of another shape. The app's own `prepareRequest` hook keeps working: the plugin wraps `configureServerFunctionsClient` so the build's stamp runs first and the app's hook runs after it. Dev is unchanged, a server built without a client build checks nothing, and a custom `runtime` is left alone.
