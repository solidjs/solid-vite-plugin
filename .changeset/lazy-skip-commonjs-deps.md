---
"@solidjs/vite-plugin": patch
---

Only run the `lazy()` module-URL transform on non-JSX modules that mention `solid-js`. Any `.js` file containing the text "lazy" was parsed as an ES module, so a CommonJS dependency with a top-level `return` (or Flow syntax) failed `vite build`. The compiler only rewrites `lazy` imported from `solid-js`, so other files are left untouched.
