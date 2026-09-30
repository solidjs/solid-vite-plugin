import { defineConfig } from 'vite';
import solidPlugin from '@solidjs/vite-plugin';

// Client start mode, zero-config spelling: `start: true` (sugar for
// `start: {}` — both mean the identical start mode with defaults) opts
// into the start-mode conventions, and the `ssr` boolean (false/omitted here)
// makes the app client-rendered. No index.html, no mount file, no server
// output: src/App.tsx is the app, src/Document.tsx (optional) is the shell.
// Dev streams the rendered shell for every HTML GET (history-fallback
// semantics) and the generated client entry render()s the app into it;
// `vite build` prerenders the shell once into dist/client/index.html (with
// the hashed entry script and CSS links) and emits nothing else — a purely
// static deployable.
//
// SOLID_FLIP_SSR=1 flips the one boolean (test/run.mjs's flip mode): the
// identical app SSRs and hydrates with zero source changes. All suite modes
// run on the boolean `start: true` form, covering the sugar end to end.
//
// SOLID_START_NODE=1 (node mode) turns on `serverFunctions` — which keeps
// dist/server for the endpoint — and `start.node`, so the build also emits
// the Node server entry dist/server/node.js: static dist/client with an
// index.html history fallback for HTML navigations, /_server through the
// kept handler. SOLID_START_NODE_ONLY=1 sets `start.node` alone (no server
// functions): the purely static build has no server bundle to wrap, so the
// build warns and emits nothing.
//
// SOLID_SHELL_FAIL=1 (prod mode's failing build) wires src/shell-failure.ts
// through `start.middleware`: the chain throws while the build prerenders the
// shell, and the build must fail rather than write the handler's contained
// 500 to dist/client/index.html.
const startNode = !!process.env.SOLID_START_NODE || !!process.env.SOLID_START_NODE_ONLY;
const shellFail = !!process.env.SOLID_SHELL_FAIL;
export default defineConfig({
  plugins: [
    solidPlugin({
      start: startNode
        ? { node: true }
        : shellFail
          ? { middleware: './src/shell-failure.ts' }
          : true,
      ssr: !!process.env.SOLID_FLIP_SSR,
      ...(process.env.SOLID_START_NODE ? { serverFunctions: true } : {}),
    }),
  ],
});
