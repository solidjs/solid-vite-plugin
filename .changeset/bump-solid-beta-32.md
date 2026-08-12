---
'@solidjs/vite-plugin': patch
---

update to solid 2.0.0-beta.32 and @dom-expressions/compiler 0.50.0-next.40 — `commitEventResponse` now ships in `@solidjs/web`, so the SSR start-mode handler imports it by name and the namespace-import fallback for pre-.40 runtimes is deleted; the solid floor moves to beta.32 accordingly
