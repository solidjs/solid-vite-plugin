---
'@solidjs/vite-plugin': patch
---

Load Babel and `@solidjs/babel-plugin` on first use instead of at import. The default native compiler never calls them, so importing the plugin takes about half as long (roughly 100 ms down to 50 ms).
