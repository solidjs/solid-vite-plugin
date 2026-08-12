---
'@solidjs/vite-plugin': patch
---

Expose the `@solidjs/vite-plugin/virtual-solid-manifest` ambient type
declarations through a package `exports` subpath so
`"types": ["@solidjs/vite-plugin/virtual-solid-manifest"]` resolves under
`moduleResolution: "bundler"` / `node16` too (previously only classic `node`
resolution found the shipped `.d.ts`).
