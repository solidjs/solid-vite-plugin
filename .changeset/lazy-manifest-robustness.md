---
'@solidjs/vite-plugin': patch
---

Harden SSR asset resolution for `lazy()` modules.

- Every dynamically imported project module in SSR-mode client builds is now emitted as an explicit facade chunk (`preserveSignature: "exports-only"`), so it always gets a manifest entry keyed by its source path and a stable `default` export — even when `manualChunks` or dual static/dynamic imports would otherwise fold it facade-less into a shared chunk. This also covers `import.meta.glob` targets that never pass through the `lazy()` moduleUrl transform.
- Emitted facade chunks are reclassified from `isEntry` to `isDynamicEntry` in the virtual manifest so the runtime's entry-asset detection can't pick a lazy facade instead of the real client entry.
- SSR transforms now append a `$$moduleUrl` export carrying the module's client-manifest key. Server-side `lazy()` (solid-js ≥ 2.0.0-beta.17) reads it off the resolved module when the callsite has no static import specifier — enabling asset resolution and hydration preloading for glob-based lazy routes. Client builds are untouched.
