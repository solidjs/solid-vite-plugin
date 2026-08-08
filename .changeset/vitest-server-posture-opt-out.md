---
'vite-plugin-solid': patch
---

Per-vitest-project server test posture: a project that sets `test.environment: 'node'` (or `'edge-runtime'`) explicitly gets the server posture end to end — server export conditions (`isServer` true), ssr codegen, and the framework inlined so the whole graph (request-event storage included) resolves into one server-build instance despite the workspace worker pool's root-derived native `--conditions`. Server-runtime unit suites (server functions, sessions) need no `deps.inline`/alias workarounds, and DOM (jsdom) and node projects coexist in one workspace.
