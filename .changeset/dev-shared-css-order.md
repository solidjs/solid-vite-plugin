---
'@solidjs/vite-plugin': patch
---

Start mode dev: a stylesheet shared by the entry graph and a lazy component now keeps its first position in `<head>`, as in production. The dev shell renders it twice. The dev style patch used to drop the earlier copy, so the stylesheet moved after the lazy component's own styles and equal-specificity overrides in the lazy component lost. When both copies are server-rendered, the patch now drops the later one.
