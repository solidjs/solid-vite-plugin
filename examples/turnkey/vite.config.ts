import { defineConfig } from 'vite';
import solidPlugin from 'vite-plugin-solid';

// Turnkey kitchen sink: the object form of `ssr` adds the serving layer on
// top of the SSR transforms, and `serverFunctions` composes with it. No
// entry files, no index.html, no dev server script — the plugin generates
// default entries around src/App.tsx, a dev middleware streams the render
// (inlining the entry graph's CSS so nothing flashes unstyled), and a plain
// `vite build` produces dist/client + dist/server (whose entry exports the
// one-line production handler). Server functions ride along: dev serves
// `/_server` from the plugin's own middleware, and the production handler
// dispatches endpoint requests to the server-function runtime before SSR.
//
// Test knobs (all exercised by test/run.mjs):
// - SSR_DOCUMENT swaps the document shell via the `ssr.document` escape hatch.
// - SERVER_FN_ENDPOINT overrides the server-function endpoint.
// - SOLID_JSX_COMPILER=babel forces the Babel JSX backend (babel-hmr mode);
//   the define exposes the active backend to the page so the test can assert
//   which one served it (their outputs are parity-identical otherwise).
// - SOLID_SERVER_COMPONENTS points the generated entries at the
//   server-components page and flips `serverFunctions: { components: true }`
//   (frames mode) — the one-line enablement under test.
const jsxCompiler =
  process.env.SOLID_JSX_COMPILER === 'babel' ? ('babel' as const) : ('native' as const);
const serverComponents = !!process.env.SOLID_SERVER_COMPONENTS;

export default defineConfig({
  define: {
    __JSX_COMPILER__: JSON.stringify(jsxCompiler),
  },
  plugins: [
    solidPlugin({
      compiler: jsxCompiler,
      ssr: serverComponents
        ? { app: 'src/frames/FramesApp.tsx' }
        : process.env.SSR_DOCUMENT
          ? { document: process.env.SSR_DOCUMENT }
          : { external: !!process.env.SOLID_EXTERNAL },
      serverFunctions: serverComponents
        ? { components: true }
        : process.env.SERVER_FN_ENDPOINT
          ? { endpoint: process.env.SERVER_FN_ENDPOINT }
          : true,
    }),
  ],
});
