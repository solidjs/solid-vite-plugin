---
'@solidjs/vite-plugin': patch
---

update to solid 2.0.0-rc.0 — the solid-js/@solidjs/web peer ranges and the babel-preset-solid dependency move from `>=2.0.0-beta.32 <2.0.0-experimental.0` to `^2.0.0-rc.0`, admitting the rc line (which the old experimental-capped upper bound excluded, since `experimental` sorts before `rc`), still flooring above the hazardous 2.0.0-experimental.* publishes, and auto-graduating to stable 2.x
