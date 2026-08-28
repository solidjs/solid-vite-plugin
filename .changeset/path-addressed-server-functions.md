---
"@solidjs/vite-plugin": minor
---

Route path-addressed server function calls (solidjs/solid#3076). A call's address is now `<endpoint>/<id>` with arguments in the query, so the dev middleware and the generated request-dispatch gate match the endpoint by mount prefix instead of exact pathname, and the dev middleware's module-preload id comes from the path segment. The retired `X-Server-Function-Id` header and `?id=` forms remain as transitional fallbacks for the RC window only — they will be dropped before the stable release.
