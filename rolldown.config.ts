import { rmSync } from 'node:fs';
import { defineConfig } from 'rolldown';

// A fresh dist/ on every build, the declarations included.
rmSync('dist', { recursive: true, force: true });

// The oldest Node the package supports (engines).
const transform = { target: 'node22.12' };

const external = [
  '@babel/core',
  '@solidjs/compiler',
  '@ampproject/remapping',
  '@solidjs/babel-plugin',
  'merge-anything',
  'vitefu',
  'magic-string',
  'vite',
];

export default defineConfig([
  {
    input: 'src/index.ts',
    platform: 'node',
    transform,
    external,
    // ESM only: Vite is ESM-only, and the Node versions the plugin supports
    // (22.12+) load this build through require() too.
    output: {
      format: 'esm',
      file: 'dist/esm/index.mjs',
      sourcemap: true,
    },
  },
  /**
   * The runtime of the Node server entry `start.nodeServer` emits into a
   * build's dist/server/node.js: the plugin reads this artifact at build time
   * and prepends the emit-time constants. Bundles the shared node<->web
   * bridge (src/http.ts) with it; `./server.js` (the sibling server bundle)
   * stays an external import, kept verbatim so it resolves in the user's
   * dist. Comments are stripped: this file lands in every user's dist, and
   * the source files keep the explanations.
   */
  {
    input: 'src/node-entry/index.ts',
    platform: 'node',
    transform,
    external: (id) => id === './server.js' || id.startsWith('node:'),
    makeAbsoluteExternalsRelative: false,
    // No `// <module id>` markers either.
    experimental: { attachDebugInfo: 'none' },
    output: {
      format: 'esm',
      file: 'dist/node-entry.mjs',
      comments: false,
    },
  },
]);
