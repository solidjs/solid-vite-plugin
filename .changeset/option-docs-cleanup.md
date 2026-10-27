---
'@solidjs/vite-plugin': patch
---

Docs: correct the `dev` option contract (left unset it means development builds under `vite dev` only, `true` also forces them in `vite build`), add a README section for `diagnostics`, and remove the README entry for `options.typescript`, which the plugin does not accept.
