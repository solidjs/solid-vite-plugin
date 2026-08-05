---
'vite-plugin-solid': patch
---

Drop the `_$SC` bootstrap head-open splice. The runtime's serialized server-component references now self-bootstrap the registry (each hydration script's first reference carries it as an idempotent expression), so nothing needs to precede the data scripts — and the splice actively broke hydration: a script ahead of the authored `<head>` elements claims as the first walked child and drifts every positional claim after it (metas claimed as title, title as link), silently in production. Requires @dom-expressions/runtime 0.50.0-next.37 / @solidjs/web 2.0.0-beta.31.
