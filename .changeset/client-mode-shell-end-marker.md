---
'@solidjs/vite-plugin': patch
---

Client start mode now strips the shell-end marker script along with the `<HydrationScript />` bootstrap. `@solidjs/web` 2.0.0-rc.15 (solidjs/solid#4002) closes every shell that rendered `<HydrationScript />` with `<script>_$HY.s[id]=1,…</script>`, and a Document shared with SSR mode carries `<HydrationScript />`. Once the plugin stripped the bootstrap, that marker threw `_$HY is not defined` in client-mode shells, in dev and in the prerendered `index.html`. Shells from earlier `@solidjs/web` versions have no marker and are unchanged.
