---
'vite-plugin-solid': patch
---

update to solid 2.0.0-beta.30 and @dom-expressions/compiler 0.50.0-next.35 (the compiler's module-URL pass now also annotates `clientOnly(() => import("x"))` calls — third argument, options slot padded with `void 0` — so the beta.30 server half can emit early modulepreload hints for browser-only modules; `resolveLazyModuleUrls` already resolves the placeholder position-independently)
