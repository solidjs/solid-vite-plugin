import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { type Plugin } from 'vite';
// vitest/config's defineConfig passes straight through to Vite and types the
// `test` block the VITEST_PROJECTS knob adds.
import { defineConfig } from 'vitest/config';
import solidPlugin from '@solidjs/vite-plugin';

// Start-mode kitchen sink: `start: {}` + `ssr: true` adds the serving layer on
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
// - SSR_DOCUMENT swaps the document shell via the `start.document` escape hatch.
// - SERVER_FN_ENDPOINT overrides the server-function endpoint.
// - SERVER_FN_CONFIGURE pins src/serverConfig.ts into the handler graph via
//   `serverFunctions.configure` (configure mode).
// - SSR_MIDDLEWARE=1 wires src/middleware.ts through `start.middleware`
//   (middleware and preview modes): a fetch-style chain fronting every
//   dispatch path with getRequestEvent() live inside it.
// - SSR_SETUP=1 wires src/setup.tsx through `start.setup` (middleware mode):
//   the per-request app-setup hook, awaited between the middleware chain and
//   renderToStream with the shared request event in hand.
// - SSR_RENDER_MODE sets `start.renderMode` (render-mode mode): `module`
//   wires src/render-mode.ts (the per-request policy: header / crawler UA /
//   `?nojs`); any other value passes through verbatim — `async` for the
//   static complete-document mode, and bogus literals or missing paths for
//   the config-validation assertions.
// - SERVER_FN_DEV_MIDDLEWARE=0 disables the built-in dev middleware via
//   `serverFunctions.devMiddleware` (no-middleware mode) — endpoint dispatch
//   becomes the host's job, like a Cloudflare-style environment plugin.
// - SSR_DEVTOOLS=0 disables the development toolbar via `start.devtools`
//   (dev-mode off sub-run); by default the workspace's @solidjs/start-devtools
//   install is auto-detected and the toolbar mounts in dev.
// - BUILD_SSR_FIRST installs an adversarial `builder.buildApp` that builds
//   the ssr environment before the client (builder-order mode) — mimicking
//   host orchestrators like @cloudflare/vite-plugin; the plugin's
//   client-build-first hook must keep the manifest available anyway.
// - BUILD_PRE_WIPE installs a nitro-v3-shaped host (builder-prepare mode):
//   a pre-order `buildApp` hook that rm -rf's the output directory (like
//   `nitro:prepare`) plus a post-order orchestrator that builds ssr and
//   skips already-built environments (like `nitro:main`). The plugin's
//   client build must happen *after* the wipe (normal order, not pre) and
//   its /complete hook must leave orchestration to the host's post hook.
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
  future: {
    removePluginHookHandleHotUpdate: 'warn',
    removePluginHookSsrArgument: 'warn',
    removeSsrLoadModule: 'warn',
  },
  // SOLID_BASE (base mode) serves and builds the app under a non-root Vite
  // `base` (e.g. /app/): preview endpoint mounting, dev lazy asset URLs, and
  // request-URL shapes must all stay base-correct.
  ...(process.env.SOLID_BASE ? { base: process.env.SOLID_BASE } : {}),
  define: {
    __JSX_COMPILER__: JSON.stringify(jsxCompiler),
  },
  // test-css-lib is written into node_modules by the css-filter mode; it
  // imports its own CSS, so the SSR environment must transform it (a
  // Node-externalized import of a bare .css file would crash the render).
  ...(process.env.CSS_FILTER === 'include' || process.env.CSS_FILTER === 'default'
    ? { ssr: { noExternal: ['test-css-lib'] } }
    : {}),
  // VITEST_PROJECTS=1 (vitest mode): both test postures in ONE workspace —
  // DOM component tests under jsdom get the client posture (browser
  // conditions, dom codegen), while the node project gets the server
  // posture end to end (server conditions, isServer true, ssr codegen)
  // just by writing `environment: 'node'`. Without the knob the config has
  // no `test` block at all: the zero-config client-posture default stays
  // under test too.
  ...(process.env.VITEST_PROJECTS
    ? {
        test: {
          projects: [
            {
              extends: true as const,
              test: {
                name: 'client',
                environment: 'jsdom',
                include: ['src/posture.test.tsx'],
              },
            },
            {
              extends: true as const,
              test: {
                name: 'server',
                environment: 'node',
                include: ['src/server-posture.test.tsx'],
              },
            },
          ],
        },
      }
    : {}),
  ...(process.env.BUILD_SSR_FIRST
    ? {
        builder: {
          async buildApp(builder) {
            await builder.build(builder.environments.ssr!);
            await builder.build(builder.environments.client!);
          },
        },
      }
    : {}),
  plugins: [
    solidPlugin({
      compiler: jsxCompiler,
      ssr: true,
      start: serverComponents
        ? { app: 'src/frames/FramesApp.tsx' }
        : process.env.SSR_DOCUMENT
          ? { document: process.env.SSR_DOCUMENT }
          : {
              external: !!process.env.SOLID_EXTERNAL,
              // CSS_FILTER (css-filter mode) exercises `start.css.filter`
              // against a temp app (src/CssLibApp.tsx, written by the test)
              // whose graph pulls a temp node_modules package with CSS
              // (test-css-lib, also written by the test):
              // - exclude: prune the App.tsx graph (replaces the default
              //   node_modules exclusion).
              // - include: opt the test-css-lib graph in on top of the
              //   default baseline (app CSS must survive).
              // - conflict: the same file matched by both patterns stays
              //   excluded (createFilter's exclude-wins rule).
              // - default: no filter — the node_modules graph is pruned by
              //   the default exclusion while app CSS is collected.
              ...(process.env.CSS_FILTER === 'exclude'
                ? { css: { filter: { exclude: /App\.tsx$/ } } }
                : {}),
              ...(process.env.CSS_FILTER === 'include'
                ? { app: 'src/CssLibApp.tsx', css: { filter: { include: /test-css-lib/ } } }
                : {}),
              ...(process.env.CSS_FILTER === 'conflict'
                ? { css: { filter: { include: /App\.tsx$/, exclude: /App\.tsx$/ } } }
                : {}),
              ...(process.env.CSS_FILTER === 'default' ? { app: 'src/CssLibApp.tsx' } : {}),
              // SSR_DEVTOOLS=0 (dev-mode sub-run) opts out of the development
              // toolbar via `start.devtools`. Without the knob the workspace's
              // @solidjs/start-devtools install is auto-detected, so plain dev
              // runs double as coverage for the default-on wiring.
              ...(process.env.SSR_DEVTOOLS === '0' ? { devtools: false } : {}),
              // SSR_MIDDLEWARE=1 (middleware/preview modes): a fetch-style
              // chain fronting every dispatch path — page SSR, /_server,
              // preview — with getRequestEvent() live inside it.
              ...(process.env.SSR_MIDDLEWARE
                ? { middleware: './src/middleware.ts', errorBoundary: false }
                : {}),
              // SSR_SETUP=1 (middleware mode): the per-request app-setup
              // hook — src/setup.tsx runs between the middleware chain and
              // renderToStream, receiving the event and returning the
              // component to render (the TanStack-style async router seam).
              ...(process.env.SSR_SETUP ? { setup: './src/setup.tsx' } : {}),
              // SSR_RENDER_MODE (render-mode mode): `module` → the
              // per-request policy module; anything else verbatim
              // (`async`, or an invalid value for the validation checks).
              ...(process.env.SSR_RENDER_MODE
                ? {
                    renderMode:
                      process.env.SSR_RENDER_MODE === 'module'
                        ? './src/render-mode.ts'
                        : process.env.SSR_RENDER_MODE,
                  }
                : {}),
            },
      serverFunctions: serverComponents
        ? { components: true }
        : {
            ...(process.env.SERVER_FN_ENDPOINT ? { endpoint: process.env.SERVER_FN_ENDPOINT } : {}),
            ...(process.env.SERVER_FN_CONFIGURE ? { configure: './src/serverConfig.ts' } : {}),
            ...(process.env.SERVER_FN_DEV_MIDDLEWARE === '0' ? { devMiddleware: false } : {}),
          },
    }),
    // The nitro-v3-shaped host for builder-prepare mode. Registered after
    // the solid plugin so that, were the client-build-first hook still
    // pre-order, it would sort before the wipe and reproduce the bug
    // (client built, then deleted). The markers written into dist let the
    // test prove the wipe actually ran and who built the ssr environment.
    ...(process.env.BUILD_PRE_WIPE
      ? ([
          {
            name: 'test:host-prepare',
            apply: 'build',
            buildApp: {
              // nitro v3's `nitro:prepare`: clean the output directory
              // before any environment is built.
              order: 'pre',
              async handler(builder) {
                const dist = path.resolve(builder.config.root, 'dist');
                rmSync(dist, { recursive: true, force: true });
                mkdirSync(dist, { recursive: true });
                writeFileSync(path.join(dist, '.pre-wipe'), 'wiped');
              },
            },
          },
          {
            name: 'test:host-build',
            apply: 'build',
            buildApp: {
              // nitro v3's `nitro:main`: a post-order orchestrator that
              // builds what's left, skipping already-built environments.
              order: 'post',
              async handler(builder) {
                const built: string[] = [];
                for (const env of [builder.environments.ssr!, builder.environments.client!]) {
                  if (!env.isBuilt) {
                    await builder.build(env);
                    built.push(env.name);
                  }
                }
                writeFileSync(
                  path.resolve(builder.config.root, 'dist', '.host-built'),
                  built.join(','),
                );
              },
            },
          },
        ] satisfies Plugin[])
      : []),
  ],
});
