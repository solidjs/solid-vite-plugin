---
'vite-plugin-solid': patch
---

Keep `$ServerOnly` templates in client transforms while HMR is active so hot updates of components using `$ServerOnly` no longer throw `template is not a function`. An explicit `solid.omitServerOnlyTemplates` setting still takes precedence.
