---
'@solidjs/vite-plugin': patch
---

`@babel/core` and `@solidjs/babel-plugin` are now optional peer dependencies, and `@types/babel__core` is no longer a dependency, so a project on the default native compiler installs no Babel packages. Projects using `compiler: 'babel'` must install `@babel/core` and `@solidjs/babel-plugin`, and projects passing the `babel` option under the native compiler must install `@babel/core`; without them the plugin throws an error naming the option and the packages on the first transform. The `babel` option is now typed by the exported `BabelOptions` interface, which accepts Babel's `TransformOptions` without the plugin's declarations importing `@babel/core`.
