---
'vite-plugin-solid': patch
---

Prevent generated server-component hydration from shifting the `<head>` structure. The bootstrap now runs at the start of the existing hydration script instead of adding an unexpected first child to `<head>`.
