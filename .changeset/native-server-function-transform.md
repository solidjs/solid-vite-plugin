---
'@solidjs/vite-plugin': patch
---

The server-function `"use server"` directive transform now uses the native `transformDirectives` pass from `@dom-expressions/compiler` (Rust/Oxc) instead of the in-tree Babel implementation. Output is byte-compatible — same runtime ABI, `xxhash32(relative path)-<count>` function IDs, and manifest behavior — but the transform is faster and now reports invalid closure captures as compile-time errors: a server function referencing a binding from an intermediate enclosing scope (an enclosing function's local or parameter, a loop variable) fails the build naming the variable and its location instead of silently breaking at runtime. JSX compilation is unchanged (Babel by default, native opt-in); only the directive transform is native-always.

Note: this requires `@dom-expressions/compiler` 0.50.0-next.23 or later — earlier releases do not include `transformDirectives`. The dependency is pinned accordingly.
