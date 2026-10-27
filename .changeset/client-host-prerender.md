---
'@solidjs/vite-plugin': patch
---

Use the resolved client and server build directories when prerendering client-mode shells and serving preview requests. Preserve the SSR service for host build orchestrators such as Nitro, including client mode without server functions, while standalone client builds still produce only static output.
