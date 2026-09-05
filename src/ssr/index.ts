// Start-mode serving for plain Vite apps: `solid({ start: {...} })` (or the
// zero-config sugar `start: true`) adds a serving layer with conventional
// entries so no hand-rolled wiring is needed, and the plugin's `ssr`
// boolean picks the mode — `ssr: true` server-renders the app per request;
// `ssr: false`/omitted is client mode (the same conventions, but the
// document shell is served/prerendered empty and the app `render()`s
// client-side). The flip between them is that one boolean.
//
// SSR mode (`start` + `ssr: true`):
// - Dev: runnable SSR environments are served by a Vite middleware. Provider-
//   owned environments serve through `virtual:solid-ssr-handler` instead.
//   Both paths inject the Vite client, dev style patch, and entry CSS as
//   `<style data-vite-dev-id>` tags before the body can paint.
// - Prod: the plugin configures a full-app build (client + server bundles
//   via the Vite environments/builder API — a single `vite build` builds
//   both) whose server entry is `virtual:solid-ssr-handler`: an
//   adapter-agnostic named `handleRequest(Request) => Promise<Response>` plus
//   a default Fetchable `{ fetch(request) }` export. Both scope each request
//   with `provideRequestEvent`, stream the render, and resolve hashed client
//   assets through `virtual:solid-manifest`.
// - Entries are conventional with escape hatches: `src/entry-server.*` /
//   `src/entry-client.*` are used when present (or set explicitly); when
//   absent, default entries are generated from a single root component
//   (`start.app`, defaulting to `src/App.*`) wrapped in a document shell
//   (`start.document`, defaulting to `src/Document.*`, else a built-in one).
// - When `serverFunctions` is also enabled, the handler composes the
//   endpoint on every surface; the runnable-dev server-function middleware
//   pre-loads the referenced module, then dispatches through this handler.
// - Every dispatch runs under a stub-backed request event
//   (`createRequestEvent`) with the optional `start.middleware` chain fronting
//   it, and page responses go through the runtime's `createSSRResponse`
//   head lifecycle (commit at shell flush, real pre-flush redirects, the
//   script fallback post-flush).
// - `start.renderMode` decides how a page render becomes a body: `'stream'`
//   (default) flushes the shell with fallbacks and streams boundaries in
//   behind it; `'async'` awaits the settled document (no fallbacks or swap
//   scripts — complete for no-JS clients); a module path decides per
//   request, and `handleRequest(request, { renderMode })` overrides both.
// - `vite preview` serves dist/client statically and dispatches everything
//   else through the built handler — the production path, middleware
//   included, with no server file needed.
//
// Client mode (`start` without `ssr: true`) rides the same machinery with
// three deltas: the generated server entry renders the document shell
// WITHOUT the app (dev serving doubles as history fallback, and a
// post-build hook prerenders it once into dist/client/index.html), the
// generated client entry render()s instead of hydrating, and dist/server is
// dropped from the output unless `serverFunctions` needs it for the
// endpoint. Client code compiles non-hydratable, exactly like a plain SPA.
import { existsSync, rmSync, writeFileSync } from 'fs';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  type DevEnvironment,
  type FilterPattern,
  normalizePath,
  type Plugin,
  type PreviewServer,
  type ViteDevServer,
} from 'vite';
import { getEnvironmentConsumer, isRunnableEnvironment } from '../environment.js';
import {
  DEVTOOLS_MOUNT_ID,
  DEVTOOLS_PACKAGE,
  devtoolsMountModuleCode,
} from '../devtools/index.js';
import { DIAGNOSTICS_CLIENT_ID, detectDiagnosticsPackage } from '../diagnostics/index.js';
import {
  collectDevStyles,
  collectDevStyleSources,
  type DevStyleFilter,
  devStylePatch,
  renderDevStyleTag,
} from '../dev-manifest.js';
import { joinBase, sendWebResponse, webRequestFromNode } from '../http.js';

/**
 * Options for the main plugin's `start` option (`start: true` is
 * sugar for the empty bag). One bag serves both modes — the plugin's `ssr`
 * boolean picks between them, so flipping a project between
 * client-rendered and server-rendered is toggling that boolean, never
 * reshaping this object. Server-only options (`entryServer`, `external`)
 * are documented no-ops in client mode: they stay in the config across a
 * flip instead of erroring.
 */
export interface StartOptions {
  /**
   * Root component module for generated entries (the zero-config path).
   * Resolved relative to the Vite root.
   *
   * @default "src/App.{tsx,jsx,ts,js,tsrx}" (also probes lowercase "src/app.*")
   */
  app?: string;
  /** Options for development CSS crawling. */
  css?: {
    /**
     * Filter for the modules traversed while collecting the CSS that dev
     * SSR inlines into `<head>`. Patterns are
     * [picomatch](https://github.com/micromatch/picomatch) globs or regexes;
     * relative globs resolve against the Vite root. CSS files themselves
     * and virtual modules always pass — the filter decides which module
     * graphs are crawled, not which stylesheets are kept.
     *
     * `exclude` prunes matching graphs and defaults to `/node_modules/`
     * (providing your own replaces the default). `include` opts matching
     * files back in on top of that baseline — typically a package whose
     * CSS should be server-inlined to avoid a development FOUC, e.g.
     * `{ include: /node_modules\/some-ui-lib/ }`. A file matching both
     * stays excluded. Development only: production CSS always comes from
     * the built assets.
     */
    filter?: {
      include?: FilterPattern;
      exclude?: FilterPattern;
    };
  };
  /**
   * Server entry module. Must export `render(request?, context?)` returning
   * a `renderToStream` result, an HTML string, or a `Response`.
   * `context.clientEntry` carries the resolved client entry URL.
   *
   * Server mode only — ignored in client mode, where the server entry is
   * always generated (it renders the document shell without the app, for
   * dev serving and the build-time prerender). Conventional
   * `src/entry-server.*` files are likewise ignored there.
   *
   * @default "src/entry-server.{tsx,jsx,ts,js,mjs,tsrx}" when present, else a
   * generated entry rendering `<Document><App /></Document>`
   */
  entryServer?: string;
  /**
   * Client entry module. In SSR mode it hydrates; in client mode it mounts
   * (a generated one calls `render()`), and it stands alone — no pairing
   * rule with a server entry.
   *
   * @default "src/entry-client.{tsx,jsx,ts,js,mjs,tsrx}" when present, else a
   * generated entry
   */
  entryClient?: string;
  /**
   * Document shell component wrapping the app in generated entries. Receives
   * `props.children` and must render the full `<html>` document including
   * `<HydrationScript />` (in client mode, where nothing hydrates, the
   * handler strips its output from the served/prerendered shell — a shared
   * Document costs nothing across the flip; the built-in shell omits it per
   * mode). Only used when the server entry is generated.
   *
   * @default "src/Document.{tsx,jsx,tsrx}" when present, else a built-in shell
   */
  document?: string;
  /**
   * Path to a server-only module (resolved relative to the Vite root) whose
   * default export is one fetch-style middleware function — `(request,
   * next) => Response | Promise<Response>` — or an array of them, composed
   * in order. The chain fronts every request the plugin dispatches — page
   * SSR, the server-function endpoint, dev and production, `vite preview` —
   * and runs inside the request-event scope, so `getRequestEvent()` works
   * exactly as it does in application code (decorate `locals`, write the
   * `response` stub). `next()` advances the chain (pass a `Request` to
   * substitute it downstream); nothing reaches the wire until the outermost
   * middleware returns, so headers on the returned `Response` stay mutable
   * after `next()` — streamed bodies included — and error middleware is a
   * plain `try { return await next(); } catch { ... }`.
   *
   * All methods and accept types dispatch through the chain — API routes
   * and no-JS form POSTs included, in dev exactly as in production. A
   * non-page request (anything but an HTML-accepting GET) that no
   * middleware handled falls back to Vite's own pipeline in dev instead of
   * rendering the page at it.
   *
   * @default undefined
   */
  middleware?: string;
  /**
   * Path to a server-only module (resolved relative to the Vite root) whose
   * default export runs once per request in the generated server entry,
   * after the middleware chain has dispatched to the page render and
   * immediately before `renderToStream`: `(event, App) => Component | void |
   * Promise<Component | void>`. The per-request seam for routers that must
   * prepare an app instance before SSR begins (create a router bound to the
   * request, `await router.load()`, then render): return a component and the
   * generated entry renders it in the app's place inside the Document;
   * return nothing and `<App />` renders unchanged. `event` is the shared
   * request event — the same one the middleware chain decorated (`locals`
   * are visible) — and the hook runs inside the request scope, so
   * `getRequestEvent()` answers in anything it calls.
   *
   * Only meaningful with generated entries: an authored `entry-server`
   * already owns its render function, so configuring both is an error.
   * Server mode only — ignored in client mode (there is no per-request app
   * render to prepare), so the config survives the `ssr` boolean flip.
   *
   * @default undefined
   */
  setup?: string;
  /**
   * How the generated handler turns a page render into a response body.
   *
   * - `'stream'` (default): the document shell flushes as soon as it is
   *   ready, with `<Loading>` fallbacks in place; boundary content follows
   *   in later chunks and is swapped in by inline scripts. Best TTFB, but
   *   a client that never runs JavaScript (crawlers, `curl`, no-JS
   *   browsers) is left looking at the fallbacks (solidjs/solid#3280).
   * - `'async'`: the handler awaits the render until every boundary has
   *   settled and sends one complete document. Nothing has flushed, so
   *   each resolved boundary is spliced in place of its placeholder — no
   *   fallback markup, no swap templates or scripts — while hydration data
   *   still serializes, so JavaScript clients hydrate exactly as before.
   *   The tradeoffs are inherent: time-to-first-byte waits for the slowest
   *   boundary, and the whole page buffers in memory before it is sent.
   *   `deferStream` is moot here (everything defers), and a `Location`
   *   header written mid-render becomes a real 3xx instead of the
   *   post-flush script fallback.
   * - A module path (resolved relative to the Vite root, following the
   *   `middleware`/`setup` convention — a Vite config cannot serialize a
   *   closure into the generated handler): the module default-exports
   *   `(event) => 'stream' | 'async' | Promise<'stream' | 'async'>`, called
   *   per request inside the request scope after the middleware chain (so
   *   `event.locals` decoration is visible) — e.g. `'async'` for crawler
   *   user agents or a `?nojs` flag, `'stream'` for everyone else.
   *
   * Hosts driving the handler directly can override all of the above per
   * call with `handleRequest(request, { renderMode })`; precedence is that
   * runtime option, then the module function's result, then this static
   * value. Applies to generated and authored entries alike (an authored
   * `render()` returning a `renderToStream` result is awaited the same
   * way). Server mode only — ignored in client mode, where the served
   * shell has no boundaries to settle.
   *
   * @default 'stream'
   */
  renderMode?: 'stream' | 'async' | (string & {});
  /**
   * Typed, validated environment variables. A schema file — conventionally
   * `env.ts` (or `env.js`) at the project root, probed automatically —
   * default-exports `{ server?, client? }` maps of Standard Schema
   * validators (zod, valibot, arktype, mixable per key), and the plugin
   * exposes the validated values through `virtual:env/server` (all vars,
   * server module graphs only — a client-graph import is a hard error) and
   * `virtual:env/client` (the `VITE_`-prefixed `client` side; the prefix is
   * enforced at config time). Validation runs at config/build time in node
   * only against Vite's `loadEnv` merge of the `.env*` files (with
   * `process.env` winning), which the plugin also folds into `process.env`
   * itself — no `loadEnv` boilerplate in vite.config. Failures fail the
   * build / render the dev error overlay with the per-key report, and a
   * `solid-env.d.ts` is generated next to the schema so both virtual
   * modules are fully typed by inference.
   *
   * Client values are baked as plain JSON (that's what `VITE_` means); no
   * validator ships in a client bundle, and a client-build leak scan
   * errors when a server value shows up in a client chunk. Server values
   * are NOT baked: `virtual:env/server` reads `process.env` at server boot
   * and validates through your schema (imported into the server bundle
   * only), so platform-injected vars work and secrets rotate without a
   * rebuild — no secret exists in any dist artifact. Build-time server
   * failures are a deferred-to-boot warning; dev failures stay hard.
   * Boot validation is synchronous — the generated module carries no
   * top-level await, so server bundles work on non-esnext targets
   * (Nitro's node-server preset needs no `esnext` override) — which is
   * why async validators are rejected for `server` keys at config time
   * (`client` keys may stay async: they are awaited at build time).
   *
   * `true` requires the conventional file (error when missing); a string
   * is an explicit schema path; `false` disables even the probing.
   * Env is a start-mode feature: without `start` there is no env layer.
   *
   * @default undefined (probe env.ts / env.js; off when absent)
   */
  env?: boolean | string;
  /**
   * Enable the development toolbar. By default it is enabled when
   * `@solidjs/start-devtools` is installed. Setting this to `true` requires
   * the package, while `false` disables it.
   *
   * @default undefined
   */
  devtools?: boolean;
  /**
   * Add the default production error boundary to generated entries.
   * Disable this when application middleware owns error handling. Authored
   * entries are unaffected.
   *
   * @default true
   */
  errorBoundary?: boolean;
  /**
   * Let a host integration own the server environment — build wiring and
   * HTTP serving alike. The plugin skips its start-mode server-build config and
   * stands its dev middlewares down (SSR serving and the server-function
   * endpoint); the generated `virtual:solid-ssr-handler` self-serves
   * instead, inlining dev styles through a virtual module and composing the
   * server-function endpoint. Its named `handleRequest(request)` and default
   * Fetchable exports provide the same contract in dev and production.
   * Generated entries and the client manifest are still provided.
   *
   * Often unnecessary: a provider-owned (non-runnable) `ssr` dev environment
   * is detected automatically and the middlewares stand down on their own;
   * the normal `ssr` environment also exposes the handler as an `index`
   * service entry for provider build orchestrators. Set this only when the
   * host does not adopt that environment — for example, when it uses a
   * different name or independently configures the server build. To hand
   * over only the server-function endpoint, use
   * `serverFunctions.devMiddleware: false` instead.
   *
   * Server mode only — ignored in client mode (there is no server side to
   * hand over; the shell prerender and, with `serverFunctions`, the
   * endpoint handler are the whole story).
   *
   * @default false
   */
  external?: boolean;
}

// Server-only start-mode request handler; also the server bundle's entry so a
// production server is one import away from `Request -> Response`. Exported
// for the main plugin to thread into the server-function dev middleware,
// which dispatches through it when SSR start mode is active (one middleware
// chain and one request event across both dispatch paths).
export const SSR_HANDLER_ID = 'virtual:solid-ssr-handler';
const HANDLER_ID = SSR_HANDLER_ID;
// Dev-only response marker: the generated dev handler answers non-page
// requests that fell through the whole middleware chain to the terminal
// page dispatch with a marked 404 instead of rendering HTML at them, and
// the dev middleware hands those back to Vite's pipeline. Production has no
// such seam — every unhandled request renders — but production also has no
// Vite pipeline to fall back to.
const DEV_FALLTHROUGH_HEADER = 'x-solid-dev-fallthrough';
// Private protocol between the two generated modules when `start.setup` is
// async: the entry hands the handler the renderToStream result under this
// key, because a promise resolving to the stream BARE would adopt the
// stream's thenable (which waits for the complete render) and buffer it.
const STREAM_BOX = '__solidSetupStream';
const DEV_STYLES_ID = 'virtual:solid-ssr-dev-styles';
const RESOLVED_DEV_STYLES_ID = '\0' + DEV_STYLES_ID;
// Generated default entries / document shell. The `.tsx` suffix routes them
// through the plugin's normal JSX transform (per-environment SSR/DOM
// compile), exactly like user-authored entry files.
const ENTRY_SERVER_ID = 'virtual:solid-ssr-entry-server.tsx';
const ENTRY_CLIENT_ID = 'virtual:solid-ssr-entry-client.tsx';
const DOCUMENT_ID = 'virtual:solid-ssr-document.tsx';
const ERROR_BOUNDARY_ID = 'virtual:solid-ssr-error-boundary.tsx';

const MANIFEST_ID = 'virtual:solid-manifest';
const SERVER_FUNCTION_HANDLER_ID = 'virtual:solid-server-function-handler';
const STORAGE_SOURCE = '@solidjs/web/storage';

const ENTRY_EXTENSIONS = ['.tsx', '.jsx', '.ts', '.js', '.mjs', '.tsrx'];
const APP_EXTENSIONS = ['.tsx', '.jsx', '.ts', '.js', '.tsrx'];
const DOCUMENT_EXTENSIONS = ['.tsx', '.jsx', '.tsrx'];

function probe(root: string, stem: string, extensions: string[]): string | null {
  for (const ext of extensions) {
    if (existsSync(path.resolve(root, stem + ext))) return stem + ext;
  }
  return null;
}

/** Normalizes a user-supplied module path to a root-relative one (no leading slash). */
function normalizeUserPath(root: string, spec: string, option: string): string {
  const absolute = path.isAbsolute(spec) ? spec : path.resolve(root, spec);
  if (!existsSync(absolute)) {
    throw new Error(`[@solidjs/vite-plugin] start.${option} does not exist: ${spec}`);
  }
  const relative = path.relative(root, absolute).split(path.sep).join('/');
  if (relative.startsWith('..')) {
    throw new Error(`[@solidjs/vite-plugin] start.${option} must live inside the Vite root: ${spec}`);
  }
  return relative;
}

type RenderMode = 'stream' | 'async';

/**
 * Resolves `start.renderMode` at config time: a literal mode, or the
 * absolute path of a per-request module (`mode` stays the `'stream'`
 * default then; the module decides per request). Anything else is a
 * config error with the fix in the message — an unknown literal is far
 * more likely a typo than a file, so the message names both readings.
 */
function resolveRenderMode(
  root: string,
  value: StartOptions['renderMode'],
): { mode: RenderMode; path: string | null } {
  if (value === undefined) return { mode: 'stream', path: null };
  // (`string & {}` keeps editor completion for the literals; TS cannot
  // narrow it away by equality, hence the assertion.)
  if (value === 'stream' || value === 'async') return { mode: value as RenderMode, path: null };
  const usage =
    `start.renderMode must be 'stream' (the default), 'async', or the path of a module ` +
    `(relative to the Vite root) default-exporting a per-request function ` +
    `((event) => 'stream' | 'async' | Promise<...>)`;
  if (typeof value !== 'string') {
    throw new Error(
      `[@solidjs/vite-plugin] ${usage}; got ${typeof value}. A Vite config cannot serialize a ` +
        `closure into the generated handler — put the function in a module (e.g. ` +
        `./src/render-mode.ts) and pass its path instead.`,
    );
  }
  const absolute = path.isAbsolute(value) ? value : path.resolve(root, value);
  if (!existsSync(absolute)) {
    throw new Error(
      `[@solidjs/vite-plugin] ${usage}; got ${JSON.stringify(value)}, which is neither a mode ` +
        `nor an existing file.`,
    );
  }
  return {
    mode: 'stream',
    path: path.resolve(root, normalizeUserPath(root, value, 'renderMode')),
  };
}

interface ResolvedEntries {
  /** Root-relative path or virtual id. */
  entryServer: string;
  /** Root-relative path or virtual id. */
  entryClient: string;
  /** Whether the entries are generated virtual modules. */
  generated: boolean;
  /** Absolute path of the app root component (generated entries only). */
  app: string | null;
  /** Absolute path of the document shell, or the built-in virtual id. */
  document: string | null;
}

function resolveEntries(root: string, options: StartOptions, clientMode: boolean): ResolvedEntries {
  const explicitClient = options.entryClient
    ? normalizeUserPath(root, options.entryClient, 'entryClient')
    : null;

  if (clientMode) {
    // Client mode: the server entry is always generated (it renders the
    // document shell only — no App — for dev serving and the build-time
    // prerender); `start.entryServer` and conventional src/entry-server.*
    // files are documented no-ops here, so a project flipping the `ssr`
    // boolean never has to touch them. No entry pairing rule either: an
    // authored client entry stands alone. The document resolves in every
    // case because it IS the page in this mode.
    const document = options.document
      ? normalizeUserPath(root, options.document, 'document')
      : probe(root, 'src/Document', DOCUMENT_EXTENSIONS);
    const entryClient = explicitClient ?? probe(root, 'src/entry-client', ENTRY_EXTENSIONS);
    if (entryClient) {
      return {
        entryServer: ENTRY_SERVER_ID,
        entryClient,
        generated: false,
        app: null,
        document: document ? path.resolve(root, document) : null,
      };
    }
    const app = options.app
      ? normalizeUserPath(root, options.app, 'app')
      : (probe(root, 'src/App', APP_EXTENSIONS) ?? probe(root, 'src/app', APP_EXTENSIONS));
    if (!app) {
      throw new Error(
        `[@solidjs/vite-plugin] the \`start\` option needs an app root: add src/App.tsx ` +
          `(or set start.app), or provide a src/entry-client.* entry.`,
      );
    }
    return {
      entryServer: ENTRY_SERVER_ID,
      entryClient: ENTRY_CLIENT_ID,
      generated: true,
      app: path.resolve(root, app),
      document: document ? path.resolve(root, document) : null,
    };
  }

  const explicitServer = options.entryServer
    ? normalizeUserPath(root, options.entryServer, 'entryServer')
    : null;
  const entryServer = explicitServer ?? probe(root, 'src/entry-server', ENTRY_EXTENSIONS);
  const entryClient = explicitClient ?? probe(root, 'src/entry-client', ENTRY_EXTENSIONS);

  if (entryServer && entryClient) {
    return { entryServer, entryClient, generated: false, app: null, document: null };
  }
  if (entryServer || entryClient) {
    // One authored entry with a generated counterpart is a hydration
    // mismatch waiting to happen — the generated side wraps the app in the
    // document shell, which the authored side knows nothing about.
    const found = entryServer ? 'entry-server' : 'entry-client';
    const missing = entryServer ? 'entry-client' : 'entry-server';
    throw new Error(
      `[@solidjs/vite-plugin] found ${found} but no ${missing}; entry files come in pairs. ` +
        `Provide both (src/entry-server.* and src/entry-client.*, or the start.entryServer / ` +
        `start.entryClient options) or neither (to generate both from start.app).`,
    );
  }

  const app = options.app
    ? normalizeUserPath(root, options.app, 'app')
    : (probe(root, 'src/App', APP_EXTENSIONS) ?? probe(root, 'src/app', APP_EXTENSIONS));
  if (!app) {
    throw new Error(
        `[@solidjs/vite-plugin] the \`start\` option needs an app root: add src/App.tsx ` +
          `(or set start.app), or provide src/entry-server.* and src/entry-client.* entries.`,
    );
  }
  const document = options.document
    ? normalizeUserPath(root, options.document, 'document')
    : probe(root, 'src/Document', DOCUMENT_EXTENSIONS);

  return {
    entryServer: ENTRY_SERVER_ID,
    entryClient: ENTRY_CLIENT_ID,
    generated: true,
    app: path.resolve(root, app),
    document: document ? path.resolve(root, document) : null,
  };
}

export function startServe(
  options: StartOptions,
  internal: {
    serverFunctions?: boolean;
    serverComponents?: boolean;
    ssr?: boolean;
    styleFilter?: DevStyleFilter;
    /** `'auto'` = enable when the app has `@solidjs/diagnostics` installed. */
    diagnostics?: boolean | 'auto';
    /**
     * Reports the resolved document shell path (absolute, or null when the
     * built-in virtual document is used) back to the main plugin, which
     * declines HMR for that module's client compile (solidjs/solid#3151).
     */
    onDocumentResolved?: (documentPath: string | null) => void;
  } = {},
): Plugin[] {
  // Client mode (the `start` option without `ssr: true`) rides this exact
  // plugin with three deltas: the generated server entry renders the
  // document shell WITHOUT the app (dev serving doubles as history
  // fallback, and a post-build hook prerenders it once into
  // dist/client/index.html), the generated client entry render()s instead
  // of hydrating, and dist/server is dropped from the output unless
  // `serverFunctions` needs it for the endpoint. Everything else — entry
  // probing, the handler, middleware, dev styles, the manifest — is shared,
  // which is what makes flipping a project between the modes a one-boolean
  // config change.
  const clientMode = !internal.ssr;
  // Server components (`serverFunctions: { components: true }`): generated
  // entries additionally emit the document-SSR wiring — the render plugin +
  // direct-call transform server-side, the bootstrap script in <head>, and
  // the client-side installServerComponents() call. Authored entries carry
  // those pieces themselves (the endpoint response transform is installed by
  // the server-function handler module either way). Everything is gated
  // codegen: with the option off, none of these imports exist anywhere.
  const serverComponents = !!internal.serverComponents;
  const errorBoundary = options.errorBoundary !== false;
  const styleFilter = internal.styleFilter;
  // `'auto'` resolves against the project root in configResolved, before
  // any of the (lazy) uses in entry codegen and the entry transform.
  let diagnostics = internal.diagnostics === true;
  let devtoolsEnabled = false;
  let devtoolsResolutions: Partial<
    Record<'client' | 'server', Promise<string | null>>
  > = {};
  let devtoolsIds: Partial<Record<'client' | 'server', string | null>> = {};
  // `external` is server-mode-only (documented no-op in client mode, so a
  // host-integrated config survives the `ssr` boolean flip untouched).
  const externalServer = !clientMode && !!options.external;
  let root = process.cwd();
  let base = '/';
  let isBuild = false;
  let entries: ResolvedEntries | undefined;
  /** Absolute path of the user's middleware module, when configured. */
  let middlewarePath: string | null = null;
  /** Absolute path of the per-request setup module, when configured (server mode). */
  let setupPath: string | null = null;
  /**
   * `start.renderMode`, resolved at config time: the static mode baked into
   * the handler, or the absolute path of the per-request module deciding it
   * (server mode only — a documented no-op in client mode, whose shell has
   * no boundaries to settle).
   */
  let renderMode: RenderMode = 'stream';
  let renderModePath: string | null = null;

  function requireEntries(): ResolvedEntries {
    // config() always runs before resolveId/load/configureServer.
    if (!entries) throw new Error('[@solidjs/vite-plugin] SSR entries not resolved yet');
    return entries;
  }

  async function resolveDevtools(
    resolve: (source: string, importer: string) => Promise<{ id: string } | null>,
    importer: string,
    consumer: 'client' | 'server',
  ): Promise<boolean> {
    if (!devtoolsEnabled) return false;
    // Detect from the app graph first (the documented install location), then
    // from the plugin's own file: in pnpm-isolated apps a copy that is only a
    // dependency of the plugin is not reachable from the app's importers. The
    // resolved id is kept so imports from generated modules can use it.
    devtoolsResolutions[consumer] ??= (async () => {
      // Resolving from the plugin's own file never yields null when the
      // package is absent: it is declared an optional peer dependency, so
      // Vite answers with its `__vite-optional-peer-dep:` stub (an empty
      // module). Treat that stub as "not installed".
      const realId = (resolved: { id: string } | null) =>
        resolved && !resolved.id.startsWith('__vite-optional-peer-dep:') ? resolved.id : null;
      return (
        realId(await resolve(DEVTOOLS_PACKAGE, importer)) ??
        realId(await resolve(DEVTOOLS_PACKAGE, fileURLToPath(import.meta.url)))
      );
    })();
    const id = await devtoolsResolutions[consumer];
    devtoolsIds[consumer] = id;
    if (!id && options.devtools === true) {
      throw new Error(
        '[@solidjs/vite-plugin] start.devtools requires @solidjs/start-devtools. ' +
          'Install it as a development dependency or set start.devtools to false.',
      );
    }
    return id !== null;
  }

  /**
   * Cheap walk-up probe mirroring how the optimizer resolves bare
   * `optimizeDeps.include` entries: is @solidjs/start-devtools reachable from
   * this directory? Detection proper (resolveDevtools) runs later with a real
   * importer; this only decides whether the toolbar graph can be pre-bundled
   * at scan time.
   */
  function devtoolsReachableFrom(dir: string): boolean {
    for (let current = dir; ; ) {
      if (existsSync(path.join(current, 'node_modules', DEVTOOLS_PACKAGE, 'package.json'))) {
        return true;
      }
      const parent = path.dirname(current);
      if (parent === current) return false;
      current = parent;
    }
  }

  /**
   * The `optimizeDeps.include` spec that pre-bundles the toolbar graph, or
   * null when it cannot be resolved at all. Pre-bundling it is not just a
   * warm-start nicety: the toolbar hangs off virtual modules the scanner
   * never crawls, so without an include the optimizer only discovers it on
   * first request. That re-optimize can pair chunks from different passes
   * whose shared minified exports disagree, taking down the whole client
   * entry graph. The spec must therefore cover every install shape
   * resolveDevtools accepts: bare when the app installs the package, and
   * Vite's nested-include form (`plugin > dep`) when it is only a dependency
   * of this plugin (pnpm-isolated installs).
   */
  function devtoolsIncludeSpec(rootDir: string): string | null {
    if (devtoolsReachableFrom(rootDir)) return DEVTOOLS_PACKAGE;
    if (devtoolsReachableFrom(path.dirname(fileURLToPath(import.meta.url)))) {
      return `@solidjs/vite-plugin > ${DEVTOOLS_PACKAGE}`;
    }
    return null;
  }

  /** Import specifier for generated code: absolute for files, id for virtuals. */
  function entryServerSpec(): string {
    const { entryServer } = requireEntries();
    return entryServer === ENTRY_SERVER_ID ? entryServer : path.resolve(root, entryServer);
  }

  /** Browser URL of the client entry on the dev server (base applied). */
  function devClientEntryUrl(): string {
    const { entryClient } = requireEntries();
    return entryClient === ENTRY_CLIENT_ID
      ? joinBase(base, '/@id/' + ENTRY_CLIENT_ID)
      : joinBase(base, '/' + entryClient);
  }

  function documentSpec(): string {
    const { document } = requireEntries();
    return document ?? DOCUMENT_ID;
  }

  function styleRoots(): string[] {
    const { generated, app, document, entryServer, entryClient } = requireEntries();
    if (clientMode) {
      // The app graph's CSS is inlined into the dev shell too (not just the
      // document's): the client injects it again when the modules load and
      // the dev style patch dedupes, so this is pure anti-flash.
      return [
        generated ? app! : path.resolve(root, entryClient),
        ...(document ? [document] : []),
      ];
    }
    return generated ? [app!, ...(document ? [document] : [])] : [path.resolve(root, entryServer)];
  }

  async function devStylesModuleCode(
    environment: DevEnvironment,
    watchFile: (file: string) => void,
  ): Promise<string> {
    const styles = await collectDevStyleSources(
      environment,
      styleRoots(),
      watchFile,
      styleFilter,
    );
    if (!styles.length) return `export default '';`;

    const imports = styles.map((style, index) => {
      const specifier = style.url.includes('?') ? `${style.url}&inline` : `${style.url}?inline`;
      return `import css${index} from ${JSON.stringify(specifier)};`;
    });
    return [
      ...imports,
      `const ids = ${JSON.stringify(styles.map((style) => style.id))};`,
      `const css = [${styles.map((_, index) => `css${index}`).join(', ')}];`,
      `const escapeAttr = value => value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');`,
      `export default css.map((content, index) => {`,
      `  const id = escapeAttr(ids[index]);`,
      `  return '<style data-asset="' + id + '" data-vite-dev-id="' + id + '">' +`,
      `    content.replace(/<\\/(style)/gi, '<\\\\/$1') + '</style>';`,
      `}).join('');`,
    ].join('\n');
  }

  function errorBoundaryImport(): string[] {
    return isBuild && errorBoundary
      ? [`import { DefaultErrorBoundary } from ${JSON.stringify(ERROR_BOUNDARY_ID)};`]
      : [];
  }

  function documentTree(root: string, wrapper?: string): string[] {
    const content = wrapper ? `<${wrapper}><${root} /></${wrapper}>` : `<${root} />`;
    return isBuild && errorBoundary
      ? [
          `  <DefaultErrorBoundary>`,
          `    <Document>`,
          `      <DefaultErrorBoundary>`,
          `        ${content}`,
          `      </DefaultErrorBoundary>`,
          `    </Document>`,
          `  </DefaultErrorBoundary>`,
        ]
      : [`  <Document>`, `    ${content}`, `  </Document>`];
  }

  function generatedEntryServerCode(toolbar: boolean): string {
    if (clientMode) {
      // The client-mode shell: the document without the app. Rendered per
      // request in dev (any HTML GET gets it — history-fallback semantics)
      // and once at build time into dist/client/index.html. The client
      // entry script is injected by the handler, exactly like SSR mode.
      return [
        `import { renderToStream } from '@solidjs/web';`,
        `import manifest from ${JSON.stringify(MANIFEST_ID)};`,
        `import Document from ${JSON.stringify(documentSpec())};`,
        ...errorBoundaryImport(),
        ``,
        `export function render(request, context) {`,
        `  return renderToStream(() => (`,
        ...(isBuild && errorBoundary
          ? [
              `  <DefaultErrorBoundary>`,
              `    <Document />`,
              `  </DefaultErrorBoundary>`,
            ]
          : [`  <Document />`]),
        `  ), { manifest });`,
        `}`,
      ].join('\n');
    }
    const { app } = requireEntries();
    const streamOptions = `{ manifest, onCompleteAll: commitResponseHead${serverComponents ? ', plugins: [ServerComponentPlugin]' : ''} }`;
    return [
      `import { renderToStream, getRequestEvent, commitResponseStub } from '@solidjs/web';`,
      ...(serverComponents
        ? [
            `import { configureServerFunctionsServer } from '@solidjs/web/server-functions';`,
            `import { frameTransformDirectResult, ServerComponentPlugin } from '@solidjs/web/frames';`,
          ]
        : []),
      `import manifest from ${JSON.stringify(MANIFEST_ID)};`,
      `import Document from ${JSON.stringify(documentSpec())};`,
      `import App from ${JSON.stringify(app)};`,
      ...(toolbar ? [`import { DevToolbar } from ${JSON.stringify(DEVTOOLS_PACKAGE)};`] : []),
      ...errorBoundaryImport(),
      ...(setupPath ? [`import setup from ${JSON.stringify(setupPath)};`] : []),
      ``,
      ...(setupPath
        ? [
            `if (typeof setup !== 'function') {`,
            `  throw new Error('[@solidjs/vite-plugin] start.setup must default-export a function ' +`,
            `    '((event, App) => Component | void | Promise<...>): ' + ${JSON.stringify(options.setup)});`,
            `}`,
            ``,
          ]
        : []),
      ...(serverComponents
        ? [
            // Direct (in-process) server-function calls made during document
            // SSR must resolve to inline-renderable components; the endpoint
            // response transform is installed separately by the
            // server-function handler module (configure calls merge per key).
            `configureServerFunctionsServer({ transformDirectResult: frameTransformDirectResult });`,
            ``,
          ]
        : []),
      // Commits the response head when the render completes — BEFORE the
      // runtime disposes the render. `httpStatus`/`httpHeader` register
      // cleanups that revert their declarations unless the stub is already
      // committed; streaming commits at shell flush (this is a no-op there),
      // but the async render mode resolves the complete document only after
      // that disposal (`renderToStream(...).then` disposes, then resolves),
      // so without this the settled 404 / Location would be reverted before
      // createSSRResponse's string path could commit them.
      `function commitResponseHead() {`,
      `  const event = getRequestEvent();`,
      `  if (event) commitResponseStub(event.response);`,
      `}`,
      ``,
      ...(setupPath
        ? [
            // The per-request seam: the hook sees the same event the
            // middleware chain decorated and finishes before renderToStream
            // starts. When it is async, the stream must NOT cross the
            // promise boundary bare — a promise resolving to a
            // renderToStream result adopts its thenable (which waits for
            // the *complete* render) and buffers the stream — so it crosses
            // boxed under a private key the generated handler unboxes
            // (both modules are ours).
            `export function render(request, context) {`,
            `  const prepared = setup(getRequestEvent(), App);`,
            `  if (prepared && typeof prepared.then === 'function') {`,
            `    return prepared.then((component) => ({ ${STREAM_BOX}: renderApp(component || App) }));`,
            `  }`,
            `  return renderApp(prepared || App);`,
            `}`,
            ``,
            `function renderApp(Root) {`,
            `  return renderToStream(() => (`,
            ...documentTree('Root', toolbar ? 'DevToolbar' : undefined),
            `  ), ${streamOptions});`,
            `}`,
          ]
        : [
            `export function render(request, context) {`,
            `  return renderToStream(() => (`,
            ...documentTree('App', toolbar ? 'DevToolbar' : undefined),
            `  ), ${streamOptions});`,
            `}`,
          ]),
    ].join('\n');
  }

  function generatedEntryClientCode(toolbar: boolean): string {
    const { app } = requireEntries();
    // Dev-only: the diagnostics bridge fronts dev-mode channels, so builds
    // never see this import (mirrors the plugin's own serve-only `apply`).
    const diagnosticsImport =
      diagnostics && !isBuild ? [`import ${JSON.stringify(DIAGNOSTICS_CLIENT_ID)};`] : [];
    if (clientMode) {
      // render(), not hydrate(): the shell's body is empty, the app mounts
      // fresh. Client code compiles non-hydratable in client mode, so the
      // app cannot claim server DOM anyway. The entry script is injected
      // without `async` (plain module = deferred), so document.body is
      // complete when this runs.
      return [
        ...diagnosticsImport,
        `import { render } from '@solidjs/web';`,
        ...errorBoundaryImport(),
        ...(toolbar ? [`import { DevToolbar } from ${JSON.stringify(DEVTOOLS_PACKAGE)};`] : []),
        `import App from ${JSON.stringify(app)};`,
        ``,
        `render(() => ${
          isBuild && errorBoundary
            ? '<DefaultErrorBoundary><App /></DefaultErrorBoundary>'
            : toolbar
              ? '<DevToolbar><App /></DevToolbar>'
              : '<App />'
        }, document.body);`,
      ].join('\n');
    }
    return [
      ...diagnosticsImport,
      `import { hydrate } from '@solidjs/web';`,
      ...(toolbar ? [`import { DevToolbar } from ${JSON.stringify(DEVTOOLS_PACKAGE)};`] : []),
      ...(serverComponents
        ? [`import { installServerComponents } from '@solidjs/web/frames';`]
        : []),
      ...errorBoundaryImport(),
      `import Document from ${JSON.stringify(documentSpec())};`,
      `import App from ${JSON.stringify(app)};`,
      ``,
      ...(serverComponents
        ? [
            // Installs the t=0 document-adoption registry and the transport
            // policy (component responses morph their boundary instead of
            // decoding as data). Must run before hydrate().
            `installServerComponents();`,
            ``,
          ]
        : []),
      `hydrate(() => (`,
      ...documentTree('App', toolbar ? 'DevToolbar' : undefined),
      `), document);`,
    ].join('\n');
  }

  // Built-in document shell: minimal, hydration-ready. The client entry
  // script is injected into <head> by the handler (not rendered here) so its
  // URL never has to survive hydration or a manifest lookup client-side.
  // The client-mode variant drops <HydrationScript /> — nothing hydrates,
  // so the shell stays inert HTML. (A user-authored Document carrying
  // HydrationScript is covered too: the handler strips the event-capture
  // script from the client-mode shell.)
  const documentShellCode = [
    ...(clientMode ? [] : [`import { HydrationScript } from '@solidjs/web';`, ``]),
    `export default function Document(props) {`,
    `  return (`,
    `    <html lang="en">`,
    `      <head>`,
    `        <meta charset="utf-8" />`,
    `        <meta name="viewport" content="width=device-width, initial-scale=1.0" />`,
    ...(clientMode ? [] : [`        <HydrationScript />`]),
    `      </head>`,
    `      <body>{props.children}</body>`,
    `    </html>`,
    `  );`,
    `}`,
  ].join('\n');

  const errorBoundaryCode = [
    `import { Errored } from 'solid-js';`,
    `import { httpStatus, isServer } from '@solidjs/web';`,
    ``,
    `function ErrorFallback(props) {`,
    `  console.error(props.error());`,
    `  httpStatus(500);`,
    `  return (`,
    `    <span style="font-size:1.5em;text-align:center;position:fixed;left:0;bottom:55%;width:100%">`,
    `      {isServer ? '500 | Internal Server Error' : 'Error | Uncaught Client Exception'}`,
    `    </span>`,
    `  );`,
    `}`,
    ``,
    `export function DefaultErrorBoundary(props) {`,
    `  return (`,
    `    <Errored fallback={(error) => <ErrorFallback error={error} />}>`,
    `      {props.children}`,
    `    </Errored>`,
    `  );`,
    `}`,
  ].join('\n');

  // The handler module: dev and prod share the render/response plumbing;
  // they differ in how the client entry URL is known (baked dev URL vs a
  // manifest scan) and what gets injected into <head> (Vite client + style
  // patch in dev). The response-head lifecycle is the runtime's
  // (`createRequestEvent`/`createSSRResponse`/`commitEventResponse` from
  // @solidjs/web): every request runs under a stub-backed event,
  // `httpStatus`/`httpHeader` writes land on the wire at shell flush, a
  // pre-flush redirect becomes a real 3xx and a post-flush one the script
  // fallback, and a Response that skipped the render lifecycle (middleware
  // early return, raw entry.render Response, server functions) has the
  // stub folded on at the handler edge after the middleware chain fully
  // unwinds. When
  // `serverFunctions` is enabled the endpoint is dispatched here on every
  // surface (the runnable-dev middleware routes through this module), so
  // user middleware and the shared request event front it identically.
  function handlerModuleCode(externalDev: boolean): string {
    const { generated, entryClient } = requireEntries();
    const composeServerFunctions = internal.serverFunctions;

    const lines = [
      `import { createRequestEvent, createSSRResponse, commitEventResponse${middlewarePath ? ', composeMiddleware' : ''} } from '@solidjs/web';`,
      `import { provideRequestEvent } from ${JSON.stringify(STORAGE_SOURCE)};`,
      `import * as entry from ${JSON.stringify(entryServerSpec())};`,
      ...(middlewarePath
        ? [`import middlewareModule from ${JSON.stringify(middlewarePath)};`]
        : []),
      ...(renderModePath
        ? [`import renderModeModule from ${JSON.stringify(renderModePath)};`]
        : []),
      ...(externalDev ? [`import DEV_STYLES_HEAD from ${JSON.stringify(DEV_STYLES_ID)};`] : []),
      ...(composeServerFunctions
        ? [
            `import { handleServerFunctionRequest, endpoint } from ${JSON.stringify(SERVER_FUNCTION_HANDLER_ID)};`,
          ]
        : []),
    ];

    if (isBuild) {
      lines.push(`import manifest from ${JSON.stringify(MANIFEST_ID)};`);
      lines.push(
        ``,
        `function joinAssetPath(base, file) {`,
        `  if (typeof base !== 'string' || !base) base = '/';`,
        `  if (base[base.length - 1] !== '/') base += '/';`,
        `  return base + (file[0] === '/' ? file.slice(1) : file);`,
        `}`,
        ``,
        `let clientEntryUrl;`,
        `function resolveClientEntry() {`,
        `  if (clientEntryUrl !== undefined) return clientEntryUrl;`,
        `  clientEntryUrl = null;`,
        // The plugin's manifest module normalizes lazy facade chunks
        // (isDynamicEntry) so exactly one real entry remains flagged.
        `  for (const key in manifest) {`,
        `    const chunk = manifest[key];`,
        `    if (chunk && chunk.isEntry && chunk.file) {`,
        `      clientEntryUrl = joinAssetPath(manifest._base, chunk.file);`,
        `      break;`,
        `    }`,
        `  }`,
        `  return clientEntryUrl;`,
        `}`,
      );
    } else {
      const devHead =
        `<script>${devStylePatch}</script>` +
        `<script type="module" src="${joinBase(base, '/@vite/client')}"></script>`;
      lines.push(``, `const DEV_HEAD = ${JSON.stringify(devHead)};`);
    }

    // Middleware: the user module default-exports one fetch-style function
    // or an array, composed in order. Without one, the chain degenerates to
    // the terminal dispatch.
    lines.push(``);
    if (middlewarePath) {
      lines.push(
        `const middlewares = Array.isArray(middlewareModule) ? middlewareModule : [middlewareModule];`,
        `for (const mw of middlewares) {`,
        `  if (typeof mw !== 'function') {`,
        `    throw new Error('[@solidjs/vite-plugin] start.middleware must default-export a function or an array of functions: ' + ${JSON.stringify(middlewarePath)});`,
        `  }`,
        `}`,
        `const runMiddleware = composeMiddleware(middlewares);`,
      );
    } else {
      lines.push(`const runMiddleware = (request, next) => next(request);`);
    }

    // Render mode (`start.renderMode`): 'stream' flushes the shell with
    // fallbacks in place and streams boundary content after it; 'async'
    // adopts the renderToStream result's thenable — which waits for the
    // complete render — so one settled document goes out (the fix for
    // no-JS clients, solidjs/solid#3280). Precedence per request: the
    // `handleRequest` option (hosts driving the handler directly), then the
    // configured module's per-request result, then the static config. Every
    // source is validated against the two literals with the offender named.
    lines.push(
      ``,
      `function assertRenderMode(mode, source) {`,
      `  if (mode !== 'stream' && mode !== 'async') {`,
      `    throw new Error('[@solidjs/vite-plugin] ' + source + " must be 'stream' or 'async', got " + JSON.stringify(mode));`,
      `  }`,
      `  return mode;`,
      `}`,
    );
    if (renderModePath) {
      lines.push(
        `if (typeof renderModeModule !== 'function') {`,
        `  throw new Error('[@solidjs/vite-plugin] start.renderMode must default-export a function ' +`,
        `    "((event) => 'stream' | 'async' | Promise<...>): " + ${JSON.stringify(renderModePath)});`,
        `}`,
        `async function resolveRenderMode(event, options) {`,
        `  if (options.renderMode !== undefined) return assertRenderMode(options.renderMode, 'handleRequest options.renderMode');`,
        `  return assertRenderMode(await renderModeModule(event), 'the start.renderMode module (' + ${JSON.stringify(renderModePath)} + ') result');`,
        `}`,
      );
    } else {
      lines.push(
        `function resolveRenderMode(event, options) {`,
        `  if (options.renderMode !== undefined) return assertRenderMode(options.renderMode, 'handleRequest options.renderMode');`,
        `  return ${JSON.stringify(renderMode)};`,
        `}`,
      );
    }

    // No `_$SC` bootstrap injection: the runtime's serialized
    // server-component references self-bootstrap the registry (each
    // hydration script's first reference carries it as an idempotent
    // expression), so nothing needs to precede the data scripts. The old
    // head-open splice actively broke hydration — a script ahead of the
    // authored <head> elements claims as the first walked child and drifts
    // every positional claim after it.
    lines.push(
      ``,
      `function escapeAttribute(value) {`,
      `  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');`,
      `}`,
      ``,
      `function createHtmlChunkTransform(clientEntry, extraHead, nonce) {`,
      `  const nonceAttr = nonce ? ' nonce="' + escapeAttribute(nonce) + '"' : '';`,
      `  let first = true;`,
      `  let injected = false;`,
      `  return (chunk) => {`,
    );
    if (!generated) {
      // Authored entries reference the client entry by its dev path (the
      // `<script src="/src/entry-client.tsx">` convention); rewrite it to
      // the resolved URL like the classic server harnesses do.
      lines.push(
        `    if (clientEntry && chunk.includes(${JSON.stringify('/' + entryClient)})) {`,
        `      chunk = chunk.split(${JSON.stringify('/' + entryClient)}).join(clientEntry);`,
        `    }`,
      );
    }
    lines.push(`    if (!injected && chunk.includes('</head>')) {`, `      injected = true;`);
    if (clientMode) {
      // Nothing hydrates in client mode, so the event-capture bootstrap
      // `<HydrationScript />` renders (`window._$HY||...`) is dead weight —
      // but a Document shared with SSR mode carries it by design (the flip
      // story). Strip it from the shell here instead of making users fork
      // their Document per mode. (`<!--xs-->` is the script's stream
      // marker; the shell head always arrives in one chunk.)
      lines.push(
        `      chunk = chunk.replace(/<script(?:\\s[^>]*)?>window\\._\\$HY\\|\\|[\\s\\S]*?<\\/script>(?:<!--xs-->)?/, '');`,
      );
    }
    const headParts: string[] = [];
    // Dev: the style patch + Vite client, then either middleware-provided
    // styles or the external environment's HMR-tracked virtual styles module.
    if (!isBuild) {
      headParts.push(
        `DEV_HEAD`,
        externalDev
          ? `(extraHead === undefined ? DEV_STYLES_HEAD : extraHead)`
          : `(extraHead || '')`,
      );
    }
    if (generated || clientMode) {
      // Client-mode note: the shell never references its client entry
      // itself (even an authored one — the Document knows nothing about
      // entries), so the handler always injects it. Without `async`: module
      // scripts default to deferred execution, which is exactly right for a
      // fresh render-into-body mount (hydration, by contrast, wants to
      // start as early as possible).
      headParts.push(
        `(clientEntry ? '<script type="module"' + nonceAttr + ' src="' + clientEntry + '"${clientMode ? '' : ' async'}></' + 'script>' : '')`,
      );
    }
    if (headParts.length) {
      lines.push(`      chunk = chunk.replace('</head>', ${headParts.join(' + ')} + '</head>');`);
    }
    lines.push(
      `    }`,
      `    if (first) { first = false; chunk = '<!DOCTYPE html>' + chunk; }`,
      `    return chunk;`,
      `  };`,
      `}`,
    );

    // The handler-edge commit fold — the runtime's `commitEventResponse`
    // (named import above), the second of the response lifecycle's two
    // exits: page results leave through `createSSRResponse`, any other
    // Response (a middleware early return, a raw Response from
    // entry.render, a server-function response) leaves through
    // `commitEventResponse`, which folds the event's response stub onto it
    // (cookies append entry-by-entry, other headers gap-fill, status stays
    // the response's own) and commits the stub. Committed stubs pass
    // through untouched, so the edge applies it unconditionally.
    lines.push(``, `async function dispatchRequest(request, event, options) {`);
    if (composeServerFunctions) {
      lines.push(
        // A call's address is `<endpoint>/<id>` or `<endpoint>/data/<id>`
        // (solidjs/solid#3076, #3094); the prefix gate covers both, and the
        // bare mount still routes so a misaddressed request 404s through the
        // runtime handler instead of rendering a page at it.
        `  const requestPath = new URL(request.url).pathname;`,
        `  if (requestPath === endpoint || requestPath.startsWith(endpoint + '/')) {`,
        // The call shares the middleware chain's event (locals decoration,
        // the response stub); an explicit host-provided createEvent wins.
        // No fold here: the runtime's server-function handler runs the
        // commit seam itself, and anything it left uncommitted is caught by
        // the unconditional edge fold in handleRequest.
        `    return handleServerFunctionRequest(request, {`,
        `      createEvent: () => event,`,
        `      ...options.serverFunctions,`,
        `    });`,
        `  }`,
      );
    }
    if (!isBuild) {
      // Dev terminal gate: the dev middleware dispatches every request the
      // middleware chain might handle (API routes, no-JS form POSTs — all
      // methods and accept types, matching production), passing
      // `pageRequest: false` for the non-page ones. When such a request
      // falls through the whole chain to this terminal dispatch, nothing
      // owns it — answer with the marked 404 so the dev middleware hands
      // it back to Vite's pipeline instead of rendering HTML at it. The
      // gate reflects the wire request: only the dev middleware sets the
      // flag, so external-host dispatch and preview stay render-always.
      lines.push(
        `  if (options.pageRequest === false) {`,
        `    return new Response(null, { status: 404, headers: { ${JSON.stringify(DEV_FALLTHROUGH_HEADER)}: '1' } });`,
        `  }`,
      );
    }
    lines.push(
      isBuild
        ? `  const clientEntry = options.clientEntry || resolveClientEntry();`
        : `  const clientEntry = options.clientEntry || ${JSON.stringify(devClientEntryUrl())};`,
      // Decided before the render starts (the module form may be async),
      // inside the request scope and after the middleware chain, so a
      // per-request policy sees the decorated event.
      `  const renderMode = await resolveRenderMode(event, options);`,
      `  let result = entry.render(request, { clientEntry, ...options.context });`,
      // renderToStream results are thenables whose then() waits for the
      // *complete* render — check for pipe first so streaming survives, and
      // only await plain promises (async render functions).
      `  if (result && typeof result.pipe !== 'function' && typeof result.then === 'function') {`,
      `    result = await result;`,
      `  }`,
      ...(setupPath
        ? [
            // start.setup's async path boxes the stream (see the generated
            // entry): a bare promise resolution would adopt the stream's
            // thenable and buffer the whole render.
            `  if (result && result.${STREAM_BOX}) result = result.${STREAM_BOX};`,
          ]
        : []),
      // Async mode adopts the thenable deliberately — the very thing the
      // pipe-first check and the setup box exist to avoid in stream mode.
      // It resolves with the full HTML once every boundary settled, each
      // spliced in place pre-flush (no fallbacks, no swap scripts; hydration
      // data still serialized), and the string then takes
      // createSSRResponse's string path below: stub commit, transformChunk
      // on the whole document, and a mid-render Location as a real 3xx.
      `  if (renderMode === 'async' && result && typeof result.then === 'function') {`,
      `    result = await result;`,
      `  }`,
      // Raw Responses fold at the handler edge (handleRequest), after the
      // middleware chain unwinds — not here, where middleware above this
      // frame could still legitimately mutate headers.
      `  if (result instanceof Response) return result;`,
      // The runtime's response-head lifecycle: commit at shell flush,
      // pre-flush Location as a real redirect, post-flush Location as the
      // script fallback; the transform injects the doctype/head pieces.
      `  return createSSRResponse(result, event, {`,
      `    responseInit: options.responseInit,`,
      `    nonce: options.nonce,`,
      `    transformChunk: createHtmlChunkTransform(clientEntry, options.devHead, options.nonce),`,
      `  });`,
      `}`,
      ``,
      `export async function handleRequest(request, options = {}) {`,
      // `options.event` is the public wrapper->event extension seam: extra
      // fields (conventionally `nativeEvent`, the platform's raw request
      // object) spread over the event's defaults at creation, so hosts and
      // custom server entries can extend what getRequestEvent() answers
      // with — no new convention beyond createRequestEvent's own init
      // parameter (spreading undefined is a no-op).
      `  const event = createRequestEvent(request, options.event);`,
      // Middleware runs inside the request scope, after event creation —
      // getRequestEvent() answers in middleware exactly as in app code, and
      // nothing reaches the wire until the outermost middleware returns.
      `  const response = await provideRequestEvent(event, () =>`,
      `    runMiddleware(request, (req) => dispatchRequest(req || request, event, options)),`,
      `  );`,
      // The fold runs strictly AFTER the outermost middleware returned:
      // headers stay mutable through the whole unwind, and a middleware
      // early return (an API handler that never called next()) gets its
      // stub writes — cookies set inside the request scope, status — onto
      // the wire. Unconditional: page responses come back from
      // createSSRResponse committed and pass through untouched.
      `  return commitEventResponse(response, event);`,
      `}`,
      ``,
      `export default {`,
      `  fetch(request) {`,
      // Hosts may pass environment/context arguments after the request.
      // Do not alias fetch directly to handleRequest: its second argument is
      // the Solid handler options bag, not a provider binding object.
      `    return handleRequest(request);`,
      `  },`,
      `};`,
    );

    return lines.join('\n');
  }

  return [
    {
      name: 'solid:ssr/setup',
      enforce: 'pre',
      config(userConfig, env) {
        root = path.resolve(userConfig.root || process.cwd());
        devtoolsEnabled =
          env.command === 'serve' && !env.isPreview && options.devtools !== false;
        devtoolsResolutions = {};
        devtoolsIds = {};
        entries = resolveEntries(root, options, clientMode);
        internal.onDocumentResolved?.(entries.document);
        middlewarePath = options.middleware
          ? path.resolve(root, normalizeUserPath(root, options.middleware, 'middleware'))
          : null;
        // Server-mode only, like `entryServer`/`external` (a documented
        // no-op in client mode so configs survive the `ssr` boolean flip).
        setupPath =
          !clientMode && options.setup
            ? path.resolve(root, normalizeUserPath(root, options.setup, 'setup'))
            : null;
        if (setupPath && !entries.generated) {
          // An authored entry-server owns its render function — the seam the
          // hook needs does not exist there.
          throw new Error(
            '[@solidjs/vite-plugin] start.setup only applies to generated entries: your ' +
              'entry-server owns render() already, so call your setup step there instead ' +
              `(remove start.setup or the authored entry): ${options.setup}`,
          );
        }
        // Server-mode only as well: the client-mode shell renders no app,
        // so there is nothing to settle. Validated in every mode though —
        // a typo should not hide behind the `ssr` boolean.
        ({ mode: renderMode, path: renderModePath } = resolveRenderMode(root, options.renderMode));
        if (clientMode) {
          renderMode = 'stream';
          renderModePath = null;
        }
        if (env.isPreview) {
          if (clientMode) {
            // Client-mode builds emit a real dist/client/index.html (the
            // prerendered shell), so preview is Vite's stock static +
            // history-fallback story. When server functions are on, the
            // endpoint dispatches through the kept dist/server handler
            // (configurePreviewServer).
            return { appType: 'spa', build: { outDir: 'dist/client' } };
          }
          // `vite preview` serves `build.outDir` statically; point it at the
          // client bundle so hashed assets resolve, while HTML (and
          // everything else unhandled) falls through to the
          // configurePreviewServer dispatch below. No index.html exists, so
          // `custom` keeps preview from attempting an SPA fallback.
          return {
            appType: 'custom',
            ...(externalServer ? {} : { build: { outDir: 'dist/client' } }),
          };
        }
        const build = env.command === 'build';
        const clientInput = entries.generated
          ? ENTRY_CLIENT_ID
          : path.resolve(root, entries.entryClient);
        // Real files only — the dep scanner can't crawl virtual modules.
        // (In client mode the resolved document joins the scan/style roots
        // even with an authored client entry; in SSR mode authored entries
        // own the whole graph.)
        const scanEntries = entries.generated
          ? [entries.app!, ...(entries.document ? [entries.document] : [])]
          : [
              path.resolve(root, entries.entryClient),
              ...(clientMode && entries.document ? [entries.document] : []),
            ];
        return {
          // No index.html: dev must not fall back to SPA-serving one, and
          // the dep scanner needs explicit entries instead.
          appType: 'custom',
          ...(build
            ? externalServer
              ? {
                  environments: {
                    client: {
                      build: {
                        manifest: true,
                        rollupOptions: { input: clientInput },
                      },
                    },
                  },
                }
              : {
                  environments: {
                    client: {
                      build: {
                        manifest: true,
                        outDir: 'dist/client',
                        rollupOptions: { input: clientInput },
                      },
                    },
                    ssr: {
                      consumer: 'server',
                      build: {
                        outDir: 'dist/server',
                        rollupOptions: {
                          // `index` is the Vite service convention consumed
                          // by provider orchestrators such as Nitro. Keep the
                          // standalone artifact's established filename.
                          input: { index: HANDLER_ID },
                          output: { entryFileNames: 'server.js' },
                        },
                      },
                    },
                  },
                  // Presence of `builder` makes a plain `vite build` build the
                  // whole app (all environments: client then ssr).
                  // A classic `vite build --ssr` invocation must stay a
                  // single-environment build, so it doesn't get the flag.
                  ...(env.isSsrBuild ? {} : { builder: {} }),
                }
            : {
                ...(!clientMode && !externalServer
                  ? {
                      environments: {
                        ssr: {
                          consumer: 'server' as const,
                          build: {
                            outDir: 'dist/server',
                            rollupOptions: {
                              // Expose the same service entry during serve so
                              // provider runtimes can discover and own it.
                              input: { index: HANDLER_ID },
                              output: { entryFileNames: 'server.js' },
                            },
                          },
                        },
                      },
                    }
                  : {}),
                optimizeDeps: {
                  entries: scanEntries,
                  // Like the refresh runtime in the main plugin: the toolbar
                  // graph is injected behind modules the scanner never crawls,
                  // so pre-bundle it and the server-functions runtime up front.
                  ...(() => {
                    const spec = devtoolsEnabled ? devtoolsIncludeSpec(root) : null;
                    return spec ? { include: [spec, '@solidjs/web/server-functions'] } : {};
                  })(),
                },
              }),
        };
      },
      configEnvironment(name, config) {
        if (name !== 'ssr') return;
        config.resolve ??= {};
        const noExternal = config.resolve.noExternal;
        if (noExternal !== true) {
          config.resolve.noExternal = [
            ...(Array.isArray(noExternal) ? noExternal : noExternal ? [noExternal] : []),
            DEVTOOLS_PACKAGE,
          ];
        }
      },
      configResolved(config) {
        root = config.root;
        base = config.base;
        isBuild = config.command === 'build';
        // Test mode excluded for the same reason as the surface plugin's
        // `apply`: vitest runs a dev serve, and test pages should not get
        // the bridge import injected into their client entries.
        if (internal.diagnostics === 'auto' && !isBuild && config.mode !== 'test') {
          diagnostics = detectDiagnosticsPackage(root);
        }
      },
      resolveId(source, importer, opts) {
        if (source === HANDLER_ID) {
          return { id: HANDLER_ID, moduleSideEffects: true };
        }
        if (source === DEV_STYLES_ID) {
          return { id: RESOLVED_DEV_STYLES_ID, moduleSideEffects: true };
        }
        if (
          source === ENTRY_SERVER_ID ||
          source === ENTRY_CLIENT_ID ||
          source === DOCUMENT_ID ||
          source === ERROR_BOUNDARY_ID
        ) {
          return { id: source, moduleSideEffects: source === ENTRY_CLIENT_ID };
        }
        if (devtoolsEnabled && source === DEVTOOLS_MOUNT_ID) {
          return { id: source, moduleSideEffects: true };
        }
        // Generated modules have no directory for bare-package resolution.
        // Reuse the app-relative id captured during detection.
        const devtoolsId = devtoolsIds[getEnvironmentConsumer(this.environment, opts)];
        if (
          devtoolsId &&
          source === DEVTOOLS_PACKAGE &&
          (importer === ENTRY_SERVER_ID ||
            importer === ENTRY_CLIENT_ID ||
            importer === DEVTOOLS_MOUNT_ID)
        ) {
          return { id: devtoolsId };
        }
        return null;
      },
      async load(id, opts) {
        const consumer = getEnvironmentConsumer(this.environment, opts);
        if (id === HANDLER_ID) {
          if (consumer !== 'server') {
            this.error(`${HANDLER_ID} is server-only; import it from server code (SSR build).`);
          }
          const externalDev =
            !isBuild &&
            this.environment.mode === 'dev' &&
            (externalServer || !isRunnableEnvironment(this.environment));
          return handlerModuleCode(externalDev);
        }
        if (id === RESOLVED_DEV_STYLES_ID) {
          if (consumer !== 'server' || this.environment.mode !== 'dev') {
            this.error(`${DEV_STYLES_ID} is only available to the development server handler.`);
          }
          return devStylesModuleCode(this.environment, (file) => this.addWatchFile(file));
        }
        if (id === ENTRY_SERVER_ID) {
          const toolbar = clientMode
            ? false
            : await resolveDevtools(
                (source, importer) => this.resolve(source, importer, { skipSelf: true }),
                requireEntries().app!,
                'server',
              );
          return generatedEntryServerCode(toolbar);
        }
        if (id === ENTRY_CLIENT_ID) {
          const toolbar = await resolveDevtools(
            (source, importer) => this.resolve(source, importer, { skipSelf: true }),
            requireEntries().app!,
            'client',
          );
          return generatedEntryClientCode(toolbar);
        }
        if (id === DOCUMENT_ID) return documentShellCode;
        if (id === ERROR_BOUNDARY_ID) return errorBoundaryCode;
        if (id === DEVTOOLS_MOUNT_ID) {
          let enabled = false;
          if (devtoolsEnabled && consumer === 'client') {
            const { app, entryClient } = requireEntries();
            enabled = await resolveDevtools(
              (source, importer) => this.resolve(source, importer, { skipSelf: true }),
              app ?? path.resolve(root, entryClient),
              'client',
            );
          }
          if (!enabled) {
            this.error(`${id} is only available to the development client.`);
          }
          return devtoolsMountModuleCode();
        }
        return null;
      },
      async transform(code, id, opts) {
        if (isBuild || (!devtoolsEnabled && !diagnostics)) return null;
        const current = requireEntries();
        if (current.generated || getEnvironmentConsumer(this.environment, opts) !== 'client') {
          return null;
        }
        // Module ids are always forward-slashed; normalize the path.resolve
        // side too so the comparison holds on Windows.
        if (normalizePath(id.split('?')[0]) !== normalizePath(path.resolve(root, current.entryClient))) {
          return null;
        }
        const injected: string[] = [];
        if (diagnostics) injected.push(`import ${JSON.stringify(DIAGNOSTICS_CLIENT_ID)};`);
        if (devtoolsEnabled) {
          const toolbar = await resolveDevtools(
            (source, importer) => this.resolve(source, importer, { skipSelf: true }),
            id,
            'client',
          );
          if (toolbar) injected.push(`import ${JSON.stringify(DEVTOOLS_MOUNT_ID)};`);
        }
        if (injected.length === 0) return null;
        return {
          code: `${injected.join('\n')}\n${code}`,
          map: null,
        };
      },
      configurePreviewServer(server: PreviewServer) {
        // `vite build && vite preview` runs the production artifact as-is:
        // Vite's preview statics serve dist/client (see the config hook) and
        // everything else — pages, the server-function endpoint, middleware
        // included — dispatches through the built handler, exactly like a
        // deployed server. Hosts owning the server build (`start.external`)
        // preview through their own runner instead.
        // Client mode: pages are the static index.html (preview's own
        // history fallback serves them before this post middleware runs);
        // only the server-function endpoint needs the handler, and without
        // server functions there is no dist/server at all.
        if (externalServer || (clientMode && !internal.serverFunctions)) return;
        return () => {
          let handlerPromise: Promise<{
            handleRequest: (
              request: Request,
              options?: { event?: Record<string, unknown> },
            ) => Promise<Response>;
          }> | null = null;
          server.middlewares.use((req, res, next) => {
            (async () => {
              handlerPromise ??= import(
                pathToFileURL(path.resolve(root, 'dist/server/server.js')).href
              );
              const handler = await handlerPromise;
              // Preview's base middleware runs before this post hook and
              // strips the configured `base` from req.url; the built handler
              // compares pathnames against base-prefixed endpoints (the
              // server-function endpoint) and hands the URL to application
              // code, so restore the base — the deployed production handler
              // receives base-prefixed URLs and preview must match it.
              const response = await handler.handleRequest(
                webRequestFromNode(req, joinBase(base, req.url || '/'), res),
                // Same event extension the dev middleware and a production
                // Node entry pass: the raw Node request as `nativeEvent`.
                { event: { nativeEvent: req } },
              );
              // Preview's compression middleware buffers whole responses;
              // opting HTML out keeps SSR streaming observable, matching
              // production behavior.
              if ((response.headers.get('content-type') || '').includes('text/html')) {
                res.setHeader('content-encoding', 'identity');
              }
              await sendWebResponse(res, response);
            })().catch(next);
          });
        };
      },
      configureServer(server: ViteDevServer) {
        // The files whose static import graphs carry the app's entry CSS:
        // the app root (+ document) for generated entries, the authored
        // server entry otherwise. Their transitively imported styles are
        // inlined into <head> per request (Vite injects entry CSS from
        // client JS only, so SSR'd markup would flash unstyled without
        // this); the SSR'd tags carry data-asset + data-vite-dev-id so the
        // dev style patch drops them once Vite's own injection takes over —
        // exactly the lazy-asset dedup story, HMR included.
        // Post middleware: Vite's own middlewares (transforms, static, the
        // server-function endpoint) run first; whatever asks for HTML after
        // that gets the streamed SSR render.
        return () => {
          const ssrEnvironment = server.environments.ssr;
          if (externalServer || !isRunnableEnvironment(ssrEnvironment)) {
            return;
          }
          server.middlewares.use((req, res, next) => {
            const url = new URL(req.url || '/', 'http://localhost');
            if (url.pathname.startsWith('/@')) return next();
            const accept = req.headers.accept || '';
            const pageRequest = req.method === 'GET' && accept.includes('text/html');
            // Production dispatches every request through the handler, so
            // dev must too or API routes and no-JS form POSTs served by
            // `start.middleware` are unreachable under `vite dev`. Without
            // a middleware chain, non-page requests have nothing to reach —
            // they stay on Vite's pipeline (404s) instead of rendering HTML.
            if (!pageRequest && !middlewarePath) return next();
            (async () => {
              // Loaded through the SSR environment so the app, the request
              // event storage, and the handler share one module registry.
              const handler = await ssrEnvironment.runner.import(HANDLER_ID);
              const styles = pageRequest
                ? await collectDevStyles(server, styleRoots(), styleFilter)
                : [];
              const devHead = styles.map(renderDevStyleTag).join('');
              // Post middlewares run after Vite's base middleware stripped
              // the configured `base` from req.url; restore it so the app
              // sees the same URLs in dev as in production (where the
              // deployed handler receives base-prefixed requests).
              const response: Response = await handler.handleRequest(
                webRequestFromNode(req, joinBase(base, req.url || '/'), res),
                {
                  devHead,
                  pageRequest,
                  // The raw Node request on the event, matching what a
                  // production Node server entry passes through the
                  // `options.event` seam — getRequestEvent().nativeEvent
                  // answers the same in dev as deployed.
                  event: { nativeEvent: req },
                },
              );
              // A non-page request the chain never handled: the terminal
              // dispatch answered with the marked 404 — hand it back to
              // Vite (its 404, other post middlewares) rather than sending
              // a rendered page at a fetch()/form client.
              if (response.headers.has(DEV_FALLTHROUGH_HEADER)) return next();
              await sendWebResponse(res, response);
            })().catch((error) => {
              // Vite's error middleware renders the overlay-enabled 500 page.
              next(error);
            });
          });
        };
      },
    },
    ...(clientMode
      ? [
          {
            name: 'solid:start/prerender',
            apply: 'build',
            buildApp: {
              // Post order: this hook owns the whole client-mode app build (the
              // client-build-first orchestration pair is SSR-only). It
              // builds client-then-ssr itself — building anything from a
              // hook suppresses Vite's build-all fallback, so the ordering
              // is guaranteed and the manifest is on disk before the shell
              // bundle bakes it in — then runs the built handler once to
              // prerender the shell into dist/client/index.html and drops
              // dist/server unless server functions still need its handler.
              // The shell arrives complete from the handler: the runtime
              // registers every manifest entry's CSS during the render
              // (registerEntryAssets), so the entry graph's stylesheet
              // links are already in its head — injecting them here again
              // double-links every stylesheet.
              order: 'post' as const,
              async handler(builder: any) {
                const client = builder.environments.client;
                const ssrEnvironment = builder.environments.ssr;
                if (client && !client.isBuilt) await builder.build(client);
                if (ssrEnvironment && !ssrEnvironment.isBuilt) {
                  await builder.build(ssrEnvironment);
                }

                const serverDir = path.resolve(root, 'dist/server');
                const handler = await import(
                  pathToFileURL(path.join(serverDir, 'server.js')).href
                );
                const response: Response = await handler.handleRequest(
                  new Request(new URL(base || '/', 'http://localhost')),
                );
                writeFileSync(path.resolve(root, 'dist/client/index.html'), await response.text());
                if (!internal.serverFunctions) {
                  rmSync(serverDir, { recursive: true, force: true });
                }
              },
            },
          } satisfies Plugin,
        ]
      : []),
  ];
}
