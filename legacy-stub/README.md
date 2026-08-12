# vite-plugin-solid → @solidjs/vite-plugin

This package has been **renamed to [`@solidjs/vite-plugin`](https://www.npmjs.com/package/@solidjs/vite-plugin)**.

This is the final `vite-plugin-solid` release: it re-exports `@solidjs/vite-plugin` verbatim (default and named exports, the `virtual-solid-manifest` and `boundary-modules` type subpaths included), so existing configs keep working. No new versions will be published under this name.

To migrate, change the dependency and the import — nothing else:

```bash
npm uninstall vite-plugin-solid && npm install -D @solidjs/vite-plugin
```

```diff
- import solid from 'vite-plugin-solid';
+ import solid from '@solidjs/vite-plugin';
```

Docs and issues: [github.com/solidjs/solid-vite-plugin](https://github.com/solidjs/solid-vite-plugin)
