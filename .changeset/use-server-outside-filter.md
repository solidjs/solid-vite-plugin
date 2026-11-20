---
'@solidjs/vite-plugin': patch
---

A client module that contains a `"use server"` function but falls outside `serverFunctions.filter.include` now fails the client build, and warns in dev, instead of shipping the function body to the browser.
