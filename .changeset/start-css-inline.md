---
'@solidjs/vite-plugin': patch
---

Add `start.css.inline` to write the client entry's stylesheets into `<head>` as `<style>` tags in production builds, so the first paint does not wait for a CSS request. `{ maxSize }` keeps files over that many bytes as links. The baked `virtual:solid-manifest` carries the CSS text, and the production handler swaps each entry stylesheet link for its `<style>` in place (with the request's style nonce), so cascade order is unchanged and consumers that bypass the handler keep the links. Stylesheets that a lazy import also preloads stay links, because Vite's preload helper only dedupes against `<link>` tags. The option is ignored, with a warning, under a relative `base`.
