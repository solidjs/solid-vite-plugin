---
"vite-plugin-solid": patch
---

Update @dom-expressions/compiler to 0.50.0-next.37: the directive DCE now removes an import declaration whose surviving specifiers are all type-only after pruning (solid-start #2273), instead of leaving a bare server-module edge in the client bundle.
