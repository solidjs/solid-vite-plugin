---
'@solidjs/vite-plugin': patch
---

Start-mode per-request app setup: `start.setup` points at a server-only module default-exporting `(event, App) => Component | void | Promise<Component | void>`, awaited by the generated server entry after the middleware chain dispatches to the page render and immediately before `renderToStream`. The seam routers with async per-request preparation need for SSR (create a router bound to the request, `await router.load()`, then render) — return a component to render in the app's place, or nothing to render `<App />` unchanged. The hook sees the same request event middleware decorated and runs inside the request scope. Zero-config entries are byte-identical without the option; authored server entries own `render()` already, so combining them is a config error.
