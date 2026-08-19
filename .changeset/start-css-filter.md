---
'@solidjs/vite-plugin': patch
---

Add `start.css.filter` to control which module graphs are traversed while collecting development CSS. `exclude` prunes matching graphs (defaults to `/node_modules/`; providing one replaces the default), and `include` opts matching files in on top of that baseline — e.g. `{ include: /node_modules\/some-ui-lib/ }` server-inlines that dependency's CSS in dev. A file matching both patterns stays excluded.
