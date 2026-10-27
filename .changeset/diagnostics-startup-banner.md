---
'@solidjs/vite-plugin': patch
---

Announce the diagnostics surface in the dev-server startup block when `diagnostics: true` is set: two extra lines after Vite's URLs naming the `/__solid/diagnostics` endpoint (with its method vocabulary) and the agent skill documents shipped in node_modules. Startup output is the one channel agents reliably read even in projects with no AGENTS.md, making this the discovery path for existing apps and ports. Dev-serve only.
