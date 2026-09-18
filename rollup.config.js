import cjs from '@rollup/plugin-commonjs';
import cleaner from 'rollup-plugin-cleaner';
import { babel } from '@rollup/plugin-babel';
import { nodeResolve } from '@rollup/plugin-node-resolve';

const extensions = ['.js', '.ts', '.json', '.tsx', '.jsx'];

const external = [
  '@babel/core',
  '@solidjs/compiler',
  '@ampproject/remapping',
  '@babel/preset-typescript',
  '@solidjs/babel-plugin',
  'merge-anything',
  'vitefu',
  'vite',
];

const babelPlugin = (options = {}) =>
  babel({
    extensions,
    babelHelpers: 'bundled',
    presets: [['@babel/preset-env', { targets: { node: 'current' } }], '@babel/preset-typescript'],
    ...options,
  });

/**
 * @type {import('rollup').RollupOptions}
 */
const config = {
  input: 'src/index.ts',
  output: [
    {
      format: 'esm',
      file: 'dist/esm/index.mjs',
      sourcemap: true,
    },
    {
      format: 'cjs',
      file: 'dist/cjs/index.cjs',
      sourcemap: true,
      exports: 'named',
    },
  ],
  external,
  plugins: [
    cleaner({ targets: ['./dist/'] }),
    babelPlugin(),
    nodeResolve({ extensions, preferBuiltins: true, browser: false }),
    cjs({ extensions }),
  ],
};

/**
 * The runtime of the Node server entry `start.node` emits into a build's
 * dist/server/node.js: the plugin reads this artifact at build time and
 * prepends the emit-time constants. Bundles the shared node<->web bridge
 * (src/http.ts) with it; `./server.js` — the sibling server bundle — stays
 * an external import, kept verbatim so it resolves in the user's dist.
 * Comments are stripped: this file lands in every user's dist, and the
 * source files keep the explanations.
 *
 * @type {import('rollup').RollupOptions}
 */
const nodeEntryConfig = {
  input: 'src/node-entry/index.ts',
  output: {
    format: 'esm',
    file: 'dist/node-entry.mjs',
    sourcemap: false,
  },
  external: (id) => id === './server.js' || id.startsWith('node:'),
  makeAbsoluteExternalsRelative: false,
  plugins: [
    babelPlugin({ comments: false }),
    nodeResolve({ extensions, preferBuiltins: true, browser: false }),
  ],
};

export default [config, nodeEntryConfig];
