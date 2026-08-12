---
'@solidjs/vite-plugin': patch
---

The package is renamed from `vite-plugin-solid` to `@solidjs/vite-plugin` (#156). Migration is the dependency name and the import specifier — `npm install -D @solidjs/vite-plugin`, `import solid from '@solidjs/vite-plugin'` — everything else is unchanged. A final `vite-plugin-solid` release re-exports this package (default and named exports, subpath type declarations included) so existing setups keep working, but new installs should use the new name. User-facing strings follow: config-time errors and dev-overlay messages are now prefixed `[@solidjs/vite-plugin]`, the ambient type subpaths are `@solidjs/vite-plugin/virtual-solid-manifest` and `@solidjs/vite-plugin/boundary-modules`, and the dev-manifest bridge endpoint is `/@solidjs/vite-plugin/dev-manifest`.
