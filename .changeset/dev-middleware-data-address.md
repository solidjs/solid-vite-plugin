---
'@solidjs/vite-plugin': patch
---

Dev middleware recognizes the scripted transport's data address. Scripted server-function calls now go to `<endpoint>/data/<id>` (solidjs/solid#3094), and the middleware's module-preload step assumed exactly one path segment after the mount — a cold function only client code references would never be evaluated in the SSR environment for a data-addressed call, answering 404 under `vite dev`. Dispatch itself was unaffected (mount matching is prefix-based). The id now parses from behind the literal `data` segment too; a function id spelled `data` still parses at the bare address, since an id occupies exactly one segment.
