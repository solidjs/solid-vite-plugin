---
'@solidjs/vite-plugin': patch
---

Dev lazy-module asset URLs now carry Vite's `?t=` HMR timestamp, so after an edit the hydration preload and the app's own `import()` load one module instance instead of two (#540).
