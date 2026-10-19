<p>
  <img width="100%" src="https://raw.githubusercontent.com/solidjs/vite-plugin-solid/master/banner.png" alt="Solid Vite Plugin">
</p>

# ⚡ vite-plugin-solid

A simple integration to run [solid-js](https://github.com/solidjs/solid) with [vite](https://github.com/vitejs/vite)

<img alt="HMR gif demonstrationdemodemodemo" src=".github/hmr.gif">

# Got a question? / Need help?

Join [solid discord](https://discord.com/invite/solidjs) and check the [troubleshooting section](#troubleshooting) to see if your question hasn't been already answered.

## Features

- HMR with no configuration needed
- Drop-in installation as a vite plugin
- Minimal bundle size
- Support typescript (`.tsx`) out of the box
- Support code splitting out of the box

## Requirements

This module 100% ESM compatible and requires NodeJS `14.18.0` or later.

You can check your current version of NodeJS by typing `node -v` in your terminal. If your version is below that one version I'd encourage you to either do an update globally or use a NodeJS version management tool such as [Volta](https://volta.sh/) or [nvm](https://github.com/nvm-sh/nvm).

## Quickstart

You can use the [vite-template-solid](https://github.com/solidjs/templates) starter templates similar to CRA:

```bash
$ npx degit solidjs/templates/js my-solid-project
$ cd my-solid-project
$ npm install # or pnpm install or yarn install
$ npm run start # starts dev-server with hot-module-reloading
$ npm run build # builds to /dist
```

## Installation

Install `vite`, `vite-plugin-solid` as dev dependencies.

Install `solid-js` as dependency.

You have to install those so that you are in control to which solid version is used to compile your code.

```bash
# with npm
$ npm install -D vite vite-plugin-solid
$ npm install solid-js

# with pnpm
$ pnpm add -D vite vite-plugin-solid
$ pnpm add solid-js

# with yarn
$ yarn add -D vite vite-plugin-solid
$ yarn add solid-js
```

Add it as plugin to `vite.config.js`

```js
// vite.config.ts
import { defineConfig } from 'vite';
import solidPlugin from 'vite-plugin-solid';

export default defineConfig({
  plugins: [solidPlugin()],
});
```

## Run

Just use regular `vite` or `vite build` commands

```json
{
  "scripts": {
    "dev": "vite",
    "build": "vite build"
  }
}
```

## API

### options

- Type: Object
- Default: {}

#### options.include

- Type: (string | RegExp)[] | string | RegExp | null
- Default: undefined

A [picomatch](https://github.com/micromatch/picomatch) pattern, or array of patterns, which specifies the files the plugin should operate on.

#### options.exclude

- Type: (string | RegExp)[] | string | RegExp | null
- Default: undefined

A [picomatch](https://github.com/micromatch/picomatch) pattern, or array of patterns, which specifies the files to be ignored by the plugin.

#### options.dev

- Type: Boolean
- Default: true

This will inject `solid-js/dev` in place of `solid-js` in dev mode. Has no effect in prod.
If set to false, it won't inject it in dev.
This is useful for extra logs and debug.

#### options.hot

- Type: Boolean
- Default: true

This will inject HMR runtime in dev mode. Has no effect in prod.
If set to false, it won't inject the runtime in dev.

#### options.ssr

- Type: Boolean
- Default: false

This will force SSR code in the produced files.

#### options.babel

- Type: Babel.TransformOptions
- Default: {}

Pass any additional [babel transform options](https://babeljs.io/docs/en/options). Those will be merged with the transformations required by Solid.

#### options.solid

- Type: [babel-plugin-jsx-dom-expressions](https://github.com/ryansolid/dom-expressions/tree/main/packages/babel-plugin-jsx-dom-expressions#plugin-options)
- Default: {}

Pass any additional [babel-plugin-jsx-dom-expressions](https://github.com/ryansolid/dom-expressions/tree/main/packages/babel-plugin-jsx-dom-expressions#plugin-options).
They will be merged with the defaults sets by [babel-preset-solid](https://github.com/solidjs/solid/blob/main/packages/babel-preset-solid/index.js#L8-L25).

In dev with HMR enabled, the plugin sets `omitServerOnlyTemplates: false` for client transforms so that components containing `$ServerOnly` elements can be re-created by Solid Refresh. Pass `omitServerOnlyTemplates` explicitly to override this.

#### options.typescript

- Type: [@babel/preset-typescript](https://babeljs.io/docs/en/babel-preset-typescript)
- Default: {}

Pass any additional [@babel/preset-typescript](https://babeljs.io/docs/en/babel-preset-typescript).

#### options.extensions

- Type: (string, [string, { typescript: boolean }])[]
- Default: []

An array of custom extension that will be passed through the solid compiler.
By default, the plugin only transform `jsx` and `tsx` files.
This is useful if you want to transform `mdx` files for example.

## Note on HMR

Starting from version `1.1.0`, this plugin handle automatic HMR via [solid-refresh](https://github.com/solidjs/solid-refresh).

At this stage it's still early work but provide basic HMR. In order to get the best out of it there are couple of things to keep in mind:

- When you modify a file every state below this component will be reset to default state (including the current file). The state in parent component is preserved.

- The entrypoint can't benefit from HMR yet and will force a hard reload of the entire app. This is still really fast thanks to browser caching.

If at least one of this point is blocking to you, you can revert to the old behavior by [opting out the automatic HMR](#options) and placing the following snippet in your entry point:

```jsx
const dispose = render(() => <App />, document.body);

if (import.meta.hot) {
  import.meta.hot.accept();
  import.meta.hot.dispose(dispose);
}
```

## Building a library

Publish your components as JSX source under a `solid` export condition. The app that uses the library then compiles it with its own settings.

Solid compiles JSX at build time, and the output depends on the target. Client code, server code (`ssr`), and hydratable code are all different. A library that ships only compiled JavaScript has fixed one of these choices. For example, DOM output throws "Client-only API called on the server side" when an app renders it on the server. React and Vue libraries do not have this problem, because their compiled output is the same on the client and the server.

This plugin adds `solid` to Vite's `resolve.conditions`. It also scans your dependencies, and every package that has a `solid` key in its `exports` is excluded from dependency pre-bundling and is bundled into the SSR build instead of being externalized. Its JSX then goes through the same compile step as your own files.

### package.json

Put `solid` before `import` so Vite picks it first. Keep `import` for tools that do not know the `solid` condition. List `solid-js` as a peer dependency, so the app and the library share one copy.

```json
{
  "name": "my-solid-lib",
  "type": "module",
  "files": ["dist"],
  "sideEffects": ["**/*.css"],
  "exports": {
    ".": {
      "types": "./dist/source/index.d.ts",
      "solid": "./dist/source/index.jsx",
      "import": "./dist/index.js"
    }
  },
  "scripts": {
    "build": "vite build && tsc -p tsconfig.build.json && cp src/*.css dist/source/"
  },
  "peerDependencies": {
    "solid-js": "^1.9.0"
  }
}
```

Each subpath export, such as `"./button"`, needs its own `solid` entry.

### Source output and types

TypeScript can write the JSX source and the type declarations in one step. Set `jsx` to `preserve` so the JSX stays in the output.

```jsonc
// tsconfig.build.json
{
  "compilerOptions": {
    "target": "ESNext",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "jsx": "preserve",
    "jsxImportSource": "solid-js",
    "declaration": true,
    "outDir": "dist/source",
    "rootDir": "src",
    "strict": true,
    "skipLibCheck": true
  },
  "include": ["src"]
}
```

`tsc` does not copy CSS files. Copy them next to the output yourself, as the `build` script above does. CSS that needs a preprocessor, such as Sass, has to be compiled to plain CSS first, unless every app that uses the library also has that preprocessor installed.

### Compiled output

Vite's [library mode](https://vite.dev/guide/build.html#library-mode) builds the `import` entry. Mark `solid-js` as external so it is not bundled into the library.

```js
// vite.config.js
import { defineConfig } from 'vite';
import solid from 'vite-plugin-solid';

export default defineConfig({
  plugins: [solid()],
  build: {
    lib: { entry: 'src/index.tsx', formats: ['es'], fileName: 'index' },
    rollupOptions: { external: [/^solid-js(\/|$)/] },
  },
});
```

This output is client-only DOM code that cannot hydrate. Library mode also writes imported CSS to a separate file (`dist/index.css`) and does not import it from the JavaScript.

### Using the library

Install the library and import it. No extra configuration is needed. This also works for a package in the same monorepo that is linked through the workspace, as long as it is listed in the app's `package.json`.

If a library ships only compiled code and fails during SSR, ask its author to add a `solid` export condition.

# Troubleshooting

- It appears that Webstorm generate some weird triggers when saving a file. In order to prevent that you can follow [this thread](https://intellij-support.jetbrains.com/hc/en-us/community/posts/360000154544-I-m-having-a-huge-problem-with-Webstorm-and-react-hot-loader-) and disable the **"Safe Write"** option in **"Settings | Appearance & Behavior | System Settings"**.

- If one of your dependency spit out React code instead of Solid that means that they don't expose JSX properly. To get around it, you might want to manually exclude it from the [dependencies optimization](https://vitejs.dev/config/dep-optimization-options.html#optimizedeps-exclude)

- If you are trying to make [directives](https://www.solidjs.com/docs/latest/api#use%3A___) work, and they somehow don't try setting the `options.typescript.onlyRemoveTypeImports` option to `true`

## Migration from v1

The master branch now target vite 2.

The main breaking change from previous version is that the package has been renamed from `@amoutonbrady/vite-plugin-solid` to `vite-plugin-solid`.

For other breaking changes, check [the migration guide of vite](https://vitejs.dev/guide/migration.html).

# Testing

If you are using [vitest](https://vitest.dev/), this plugin already injects the necessary configuration for you. It even automatically detects if you have `@testing-library/jest-dom` installed in your project and automatically adds it to the `setupFiles`. All you need to add (if you want) is `globals`, `coverage`, and other testing configuration of your choice. If you can live without those, enjoy using vitest without the need to configure it yourself.

# Credits

- [solid-js](https://github.com/solidjs/solid)
- [vite](https://github.com/vitejs/vite)
