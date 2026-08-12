---
'vite-plugin-solid': patch
---

Don't default `test.environment` to jsdom for vitest browser-mode projects (`test.browser.enabled`): vitest 4 probes for the environment's package at startup and sets a failing exit code when jsdom isn't installed, even though the suite runs (and passes) in the real browser. Browser-mode projects now fall back to vitest's own node default, which has no package probe — mirroring the existing jest-dom gate. Non-browser projects keep the jsdom default.
