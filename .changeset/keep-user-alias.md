---
'vite-plugin-solid': patch
---

The plugin no longer changes `resolve.alias`. An alias object in your config now keeps priority over aliases that later plugins add, such as `vite-plugin-node-polyfills` mapping `path` (#130).
