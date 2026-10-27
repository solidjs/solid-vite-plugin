---
'@solidjs/vite-plugin': patch
---

Require solid-js / @solidjs/web 2.0.0-rc.16 (peer floor) and compile with @solidjs/compiler / @solidjs/babel-plugin rc.16. rc.16 adds `reportRequestFailure` to @solidjs/web, and start mode's production handler now reports a contained failure (a middleware throw, a `setup` failure) through it, so the `configureServerErrors` hook hears it as `{ kind: 'request', handling: 'failed', event }` — and not at all when the runtime already reported that error (an uncaught in-process server-function call stays `server-function`/`thrown`), where rc.16's per-kind ledger would otherwise have heard it twice. JSX source locations (`sourceNames.locations`, which rc.16's compilers emit) now point at the authored source on both compiler backends: the JSX transform runs after the primitive-names, `lazy()` and refresh passes have reprinted the module, so its positions are mapped back through those passes' sourcemap.
