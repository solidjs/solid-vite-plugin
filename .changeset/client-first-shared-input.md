---
'@solidjs/vite-plugin': patch
---

`ssr: true` no longer builds the client environment first when its only input is one a server environment shares (inherited from the top-level `build` config). Hosts that set the client's real input after their server builds, such as Astro with a legacy adapter entry (`virtual:astro:legacy-ssr-entry`), keep their own build order instead of failing on a client build of the server entry.
