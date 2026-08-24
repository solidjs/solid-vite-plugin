---
"@solidjs/vite-plugin": patch
---

`serverFunctions.components` now enables the SSR behavior-claims transform: ref and event-handler positions on intrinsic elements compile to guarded claim holes instead of dropping, so client behavior declared in server component markup survives serialization and morphs. SSR-only by construction (the dom generate ignores the flag); apps without the flag compile byte-for-byte as before. Compiler floor moves to `@dom-expressions/compiler@0.50.0-next.44`, which ships the `serverComponents` transform option and its types.
