---
'@solidjs/vite-plugin': patch
---

Type `virtual:solid-manifest` as what it exports: `ViteManifest` in an SSR build, the live `DevAssetResolver` in dev (now exported from the plugin). Both still pass straight into `renderToStream`'s `manifest` option; code that reads the module narrows with `if (manifest.resolve)`. Code that treated the dev export as a `ViteManifest` now gets a type error where it used to fail at runtime.
