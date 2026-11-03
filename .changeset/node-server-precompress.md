---
'@solidjs/vite-plugin': patch
---

`start.nodeServer` now precompresses the client build: the build writes a `.br` and a `.gz` beside each text file of 1 KiB or more, and `dist/server/node.js` serves the best one the request's `Accept-Encoding` allows, with `Content-Encoding`, the variant's `Content-Length` and `Vary: Accept-Encoding`. Rendered pages still stream uncompressed. `nodeServer: { precompress: false }` turns it off.
