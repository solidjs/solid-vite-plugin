---
'@solidjs/vite-plugin': patch
---

Resolve relative filter globs against the Vite root instead of `process.cwd()`.

The server-functions plugin's default include glob
(`src/**/*.{jsx,tsx,ts,js,mjs,cjs}`) is relative, and `createFilter` resolved
it against the invocation directory — so running `vite` from anywhere other
than the project root silently skipped server-function compilation entirely
(no transform, no registration). Both filters (the main plugin's
`include`/`exclude` and `serverFunctions.filter`) are now created in
`configResolved` with patterns resolved against `config.root`; user-provided
relative patterns become root-relative too, and absolute patterns are
unaffected.
