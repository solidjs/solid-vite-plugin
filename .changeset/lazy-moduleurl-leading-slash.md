---
'@solidjs/vite-plugin': patch
---

A hand-written `lazy()` moduleUrl with a leading slash (`lazy(() => import("./Page"), undefined, "/src/Page.tsx")`) now resolves like the project-relative key `src/Page.tsx` (#390). In dev the asset resolver built a protocol-relative `//src/Page.tsx` URL, so the preload failed and hydration fell back to a client render; in production the `virtual:solid-manifest` lookup missed, no client assets or root module map were emitted, and hydration threw "was not preloaded before hydration". The dev resolver (in-process, HTTP bridge, and the generated fallback) now strips the leading slash before building the URL and walking the module graph, and the baked build manifest answers slash-prefixed lookups through non-enumerable aliases, so `for…in`, `Object.keys`, and JSON consumers see the manifest unchanged.
