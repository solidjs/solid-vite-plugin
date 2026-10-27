---
'@solidjs/vite-plugin': patch
---

Chrome Performance panel tracks on by default under `vite dev`. New `performanceTracks` option (`boolean | PerformanceTracksOptions`, default `true`): the plugin injects a client module that calls `@solidjs/web/performance-tracks`' `enablePerformanceTracks()` ahead of the app's entry — a `<head>` module script for `index.html` apps, the first import of the (generated or authored) client entry in start mode — so hydration and the first interaction land on the timeline without the app enabling the tracks itself. An object passes the adapter's options through (`minMs`, `rich`, `attribution`, serialized into the module); `false` opts out. Dev serve only: never on `vite build` (`dev: true` and `observe` builds included), preview, or in test mode. The dev server already writes its `Server-Timing` metrics, which the tracks read back. Skipped with a startup warning if the installed `@solidjs/web` lacks the `./performance-tracks` subpath.
