---
'@solidjs/vite-plugin': patch
---

Move typed env out of `start` to a top-level `env` option, since it also works
without start mode. An explicit `env` (`true` or a schema path) now works in
any setup, for example a manual `ssr: true` server. Left unset, only start
mode probes for the conventional `env.ts` / `env.js`, so projects without
`start` that happen to have an unrelated `env.ts` are unaffected. `start.env`
fails at config time with a message naming the replacement.
