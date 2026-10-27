---
'@solidjs/vite-plugin': patch
---

New `observe` option: resolve Solid's observe builds for production observability. `observe: true` adds the `observe` export condition to every environment — client and server, inlined and externalized (`resolve.externalConditions`), inlining the core runtime and its consumers for server builds the way the dev posture already does so one build is loaded end to end — and turns on the compiler's `componentNames` option, so component owner labels (`<Home>`) survive minification in diagnostics and attribution paths. `componentNames` is also enabled under the dev posture, where `lazy()` and HMR wrappers otherwise hide the tag name. Requires `@solidjs/compiler` / `@solidjs/babel-plugin` ≥ 2.0.0-rc.8 (the release that adds the option).
