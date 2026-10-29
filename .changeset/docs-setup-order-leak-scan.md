---
'@solidjs/vite-plugin': patch
---

Correct the README on why `start.serverSetup` cannot be a static import (the whole graph loads before any module runs, and an async module does not hold back the imports after it) and on what the env leak scan skips.
