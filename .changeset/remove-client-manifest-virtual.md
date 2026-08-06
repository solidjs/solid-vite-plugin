---
'vite-plugin-solid': patch
---

Remove the unreleased `virtual:solid-manifest/client` module (and the `ClientAssetMap` type export). Its purpose was a route-CSS acquire/release lifecycle, which the head-management design has since ruled out: ambient, bundler-injected CSS is never lifecycle-managed — only head-registry-mounted stylesheets follow their owner — so the module had no remaining consumer. The server-side `virtual:solid-manifest` (SSR asset streaming) is untouched.
