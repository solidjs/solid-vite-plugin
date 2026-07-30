---
'vite-plugin-solid': patch
---

Replace vite's `isRunnableDevEnvironment` with a duck-typed `runner`-presence check. Vite's helper is an `instanceof` test against the caller's own `vite` module, so when the plugin resolves to a different physical vite copy than the dev server's (workspace/`link:` installs), every environment failed the check and the SSR/dev middlewares silently stood down — serving markup without hydration wiring.
