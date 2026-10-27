---
'@solidjs/vite-plugin': patch
---

Add a `frontends` option: other languages that lower to Solid can claim a file extension and compile its modules themselves (`frontends: { ".x": x() }`). A front end's `compile(source, { id, moduleId, ssr, root, solid, addWatchFile })` returns `{ code, map, css }`, given the compiler options this plugin would use for a JSX module in that environment; the result then takes the lowered `.tsrx` route (lazy and refresh passes, server functions keyed by the module's real path, `css` as a CSS module, dep scanning). Server functions in a front end's modules need `@solidjs/compiler` with secondary passes that accept any extension. `.rx` (ReactiveScript) is built in: with `@reactivescript/compiler` installed in the project, `.rx` modules compile with no option.
