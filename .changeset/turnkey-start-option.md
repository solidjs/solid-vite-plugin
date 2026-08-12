---
'@solidjs/vite-plugin': patch
---

Breaking (turnkey config reshape): Start is now a mode of the plugin. The
turnkey options move from the object form of `ssr` to a new `start` option
(`start: true` is the zero-config spelling, pure sugar for `start: {}` —
both mean the identical turnkey mode with defaults), and `ssr` is a boolean
again with one meaning everywhere — "is the app server-rendered".
`ssr: { ... }` is now a config-time error with a migration message: write
`start: { ... }` (or `start: true`) and set `ssr: true`. Options are
otherwise unchanged (`start.document`, `start.entryServer`,
`start.entryClient`, `start.middleware`, `start.external`, `start.app` for
the root component); a bare `ssr: true` without `start` keeps the
transform-only behavior, and `serverFunctions` stays orthogonal. The
`SsrOptions` type is renamed to `StartOptions`.

The reason for the split is the new **turnkey client mode**: `start` without
`ssr: true` serves the same conventions client-only. Dev streams the
rendered document shell (without the app — history-fallback semantics,
entry CSS inlined) and the generated client entry `render()`s the app into
`document.body`; `vite build` prerenders the shell once through the built
handler into `dist/client/index.html` (hashed entry script + entry CSS
links) and emits a purely static `dist/client` — `dist/server` is kept only
when `serverFunctions` needs it for the endpoint, and pages stay static.
Client code compiles exactly like a plain SPA (`generate: 'dom'`,
non-hydratable); only the document shell goes through the SSR transforms.
Server-only options (`start.entryServer`, `start.external`, conventional
`src/entry-server.*` files) are documented no-ops in client mode, so
flipping a project between SPA and SSR is toggling the one `ssr` boolean —
same App, same Document, same server functions (see `examples/start-client`,
whose test flips the same app between the modes).
