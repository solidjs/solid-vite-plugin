---
'@solidjs/vite-plugin': patch
---

Group the explicit entry overrides under `start.entries`: `start.entryServer` becomes `start.entries.server` and `start.entryClient` becomes `start.entries.client`. The old keys fail at config time with a message naming the replacement.
