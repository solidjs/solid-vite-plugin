---
"@solidjs/vite-plugin": patch
---

Follow the native compiler package rename: `@dom-expressions/jsx-compiler` is
now `@dom-expressions/compiler` (the binary is growing beyond the JSX
transform, so the name no longer singles out one pass). No option or behavior
changes — `jsx: "native"` works exactly as before.
