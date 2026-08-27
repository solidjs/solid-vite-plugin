---
"@solidjs/vite-plugin": minor
---

Route path-addressed server function calls (solidjs/solid#3076). A call's address is now `<endpoint>/<id>` with arguments in the query, so the dev middleware and the generated request-dispatch gate match the endpoint by mount prefix instead of exact pathname, and the dev middleware's module-preload id comes from the path segment (with the retired `X-Server-Function-Id` header and `?id=` forms kept as fallbacks for older client runtimes). Requires `@solidjs/web` newer than 2.0.0-rc.3 for the addressing itself; older runtimes keep working through the exact-match and fallback paths.
