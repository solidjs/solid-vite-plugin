---
"@solidjs/vite-plugin": patch
---

Unlock the @dom-expressions/compiler dependency from the exact 0.50.0-next.40 pin to the `^0.50.0-next.43` range — floors at next.43, auto-graduates to later next.N and stable 0.50.0, matching how babel-preset-solid is ranged. Absorbs the .41–.43 compiler fixes: dedicated `<!>` insertion markers for components boxed by static text (solidjs/solid#3004, content no longer lands after the trailing text), `$key` on intrinsic server JSX compiling to a `_key` attribute so the frame morph matches keyed elements by key instead of position, `transformLazy` annotating the module-URL placeholder in `lazy()`'s third argument for solid-js 2.0's `{ export }` options bag (solidjs/solid#3011), HTML-escaping of static template-literal parts in attribute/style values, innerHTML/textContent holes no longer taking the `_$scope` id reservation (solidjs/solid#3015), and the Rust 1.95 / Oxc 0.144 toolchain upgrade with the WASI linking fix.
