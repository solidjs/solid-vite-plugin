---
'@solidjs/vite-plugin': patch
---

Move the dev CSS crawl filter out of `start` to a top-level `css` option:
`start.css.filter` becomes `css.filter`. Plain `ssr: true` setups reading
`virtual:solid-manifest` already ran the crawl but had no way to configure it.
`start.css` fails at config time with a message naming the replacement.
