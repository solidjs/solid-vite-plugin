---
'@solidjs/vite-plugin': patch
---

Resolve static asset URLs in JSX: a relative `src`, `srcset`, `poster` or `href` on `<img>`, `<source>`, `<video>`, `<image>` and `<use>` becomes an import of the asset, and a `/` URL naming a public-directory file follows `base`, relative bases (Electron builds) included. The compiler used to put them in the template as written, so relative URLs resolved against the page and public URLs ignored `base`.
