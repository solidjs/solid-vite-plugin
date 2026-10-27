---
'@solidjs/vite-plugin': patch
---

`refresh: false` now disables HMR, replacing `refresh: { disabled: true }`, and the deprecated `hot` option is removed. `refresh` takes `true`, `false` or `{ granular }`. The old spellings fail at config time with a message naming the replacement.
