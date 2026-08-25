import { defineConfig } from 'vite';
import solidPlugin from '@solidjs/vite-plugin';

// Client app mode, zero-config spelling: `app: true` (sugar for
// `app: {}` — both mean the identical app mode with defaults) opts
// into the app-mode conventions, and the `ssr` boolean (false/omitted here)
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
// run on the boolean `app: true` form, covering the sugar end to end.
export default defineConfig({
  plugins: [solidPlugin({ app: true, ssr: !!process.env.SOLID_FLIP_SSR })],
});
