---
'@solidjs/vite-plugin': patch
---

Require solid-js / @solidjs/web 2.0.0-rc.13 (peer floor) and compile with @solidjs/compiler / @solidjs/babel-plugin rc.13 — runtime and compiler move in lockstep. rc.13 is the first published release with the new server-component SSR marker contract (rc.12 was never published): under `serverComponents`, a dynamic `class`/`style` compiles to a whole-attribute `ssrElementAttribute` hole, a spread element's named `ref`/`on*` ride `ssrElement`'s trailing `claims` thunk, and the runtime marks ref/event positions `_s:on:*` / `_s:ref` in place of the `_bnd` behavior-claim marker, which the rc.13 runtime no longer reads. With the old `^2.0.0-rc.10` floor an existing lockfile could keep a ≤ rc.11 compiler while the app's runtime moved to rc.13, so `serverFunctions.components` apps would emit markers the runtime ignores; the floor bump closes that window. Nothing else the plugin couples to changed between rc.11 and rc.13, so this is a range bump only.
