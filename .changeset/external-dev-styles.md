---
'vite-plugin-solid': patch
---

Let provider-owned SSR environments serve turnkey development requests without
calling `ssrLoadModule`. Entry CSS and server functions are transported through
the generated handler so isolated runtimes retain SSR styles and HMR support.

Add `ssr.external` for integrations that also own the server build wiring.
