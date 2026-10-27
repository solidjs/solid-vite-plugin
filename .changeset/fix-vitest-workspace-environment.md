---
'@solidjs/vite-plugin': patch
---

Avoid overriding environments configured in Vitest workspaces and projects with the `jsdom` default (forward-port of #323 by @carloitaben, fixes #205). A root config that defines `test.projects` (or the pre-Vitest-4 `test.workspace`) runs no tests itself, so it no longer gets `test.environment: 'jsdom'` injected — which made Vitest probe for (and prompt to install) jsdom at startup even when every project runs under node or in browser mode. Each project keeps controlling its own environment.
