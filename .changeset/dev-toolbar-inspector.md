---
'@solidjs/vite-plugin': minor
---

New `start.devtools` option: a development toolbar with runtime errors and a
server function inspector, backed by the new optional-peer package
`@solidjs/start-devtools`. By default the toolbar turns on in `vite dev`
whenever the package resolves (install it as a dev dependency) and stays off
otherwise; `start: { devtools: true }` makes the package required (a missing
install becomes an error) and `start: { devtools: false }` opts out entirely.
Generated client entries wrap the app in the toolbar's `DevToolbar` component,
authored client entries get an injected mount import instead, and either way
the wiring is dev-serve-only codegen — production builds and previews contain
none of it. The package itself is resolved from the app graph first and from
the plugin's own location as a fallback, and the virtual toolbar modules
delegate their imports to that captured resolution, so pnpm-isolated installs
work without the package being hoisted to the app root.
