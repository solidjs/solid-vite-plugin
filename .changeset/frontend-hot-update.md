---
'@solidjs/vite-plugin': patch
---

A front end can now take part in hot updates. `Frontend.hotUpdate` gets the
changed file and the modules Vite would update, and returns the modules to
update instead (the plugin's CSS module for the file is still added after).
`FrontendContext.hot` tells `compile` that the transform serves a dev client
with refresh on, so a front end whose output the refresh pass cannot swap can
add its own `import.meta.hot` handling. ReactiveScript's `.rx` front end uses
both to swap a dependency's components without reloading the page.
