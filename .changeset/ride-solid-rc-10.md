---
'@solidjs/vite-plugin': patch
---

Require solid-js / @solidjs/web 2.0.0-rc.10 (peer floor) and compile with @solidjs/compiler / @solidjs/babel-plugin rc.10 — runtime and compiler move in lockstep. rc.10 is the release the `sourceNames` work rides on: the compilers rename `componentNames` to `sourceNames` (`@solidjs/compiler` rejects the old option, so a mismatched pair fails loudly), add the `bindings` kind whose trailing `{ name }` / tag arguments on `effect`/`insert`/`spread` only the rc.10 `@solidjs/web` reads, ship the standalone `transformSourceNames` pass behind `sourceNames.primitives`, and default their own `sourceNames` to `dev`. The plugin keeps passing its resolved value explicitly (`false` when every JSX kind is off), so its posture table — not the compilers' default — decides, and `solid.sourceNames: false` stays an opt-out under `vite dev`.
