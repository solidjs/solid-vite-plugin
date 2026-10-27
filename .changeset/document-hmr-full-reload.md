---
"@solidjs/vite-plugin": patch
---

Document shell edits now trigger a full page reload instead of being silently absorbed (solidjs/solid#3151). Two sides: the resolved `start.document` / `src/Document.*` module declines HMR in its client compile (it hydrates the whole `document`, so no component swap can ever apply — self-accept + invalidate makes Vite reload instead), and server-environment updates for files with no client-graph counterpart (client-mode documents, authored entry-server, middleware) send a browser full-reload rather than staying suppressed — the suppression exists to protect client HMR from full-reload races, but a server-only file has no client update to race with.
