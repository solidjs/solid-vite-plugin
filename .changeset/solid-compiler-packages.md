---
'@solidjs/vite-plugin': minor
---

Move to the renamed Solid 2.0 compiler packages: the native JSX/directives/lazy/refresh compiler is now `@solidjs/compiler` (was `@dom-expressions/compiler`) and the Babel escape hatch is `@solidjs/babel-plugin` (was `babel-preset-solid` — now a plugin rather than a preset, hosted in `plugins` with the same pass order: user plugins run before it, user presets after). Both backends now bake in the Solid defaults (`moduleName: "@solidjs/web"`, the control-flow `builtIns`, `contextToCustomElements`, `wrapConditionals`), so the plugin only passes the posture it actually decides (`generate`/`hydratable`/`dev`/`serverComponents`) plus user `solid` options, which override the built-in defaults exactly as before.
