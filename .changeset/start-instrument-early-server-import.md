---
'@solidjs/vite-plugin': patch
---

`start.instrument`: a server-only module the plugin runs to completion before anything else in the server graph loads — the app, the middleware, `@solidjs/web`, every dependency. The seam for instrumentation that must patch the runtime before the modules it patches are loaded (an APM's OpenTelemetry setup, a profiler, a `module.register` hook), honored on every surface: `vite dev`, `vite build`, `vite preview`, and a host consuming the handler entry. Replaces the per-host `node --import instrument.mjs` dance.

Import order cannot do this in ESM — static imports are hoisted and evaluated in dependency order — so the generated handler entry becomes `await import(instrument); await import(handler)`, with the handler's surface (`handleRequest`, the `fetch` default) re-declared by name. The module may be async and needs no exports; the server build must keep code splitting on (the default).

Also: the `componentNames` note in the compiler options no longer calls the labels DOM-only — the SSR generate emits them too from the compilers that carry solidjs/solid#3441 (2.0.0-rc.9), and the start-ssr suite gains an `observe` mode that asserts an `observe: true` production build resolves the observe artifacts and carries component labels (the SSR half asserted once the workspace rides an rc that emits them).
