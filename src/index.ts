import * as babel from '@babel/core';
import type { TransformOptions as JsxCompilerOptions } from '@solidjs/compiler';
import remapping from '@ampproject/remapping';
import solid from '@solidjs/babel-plugin';
import { existsSync, readFileSync, realpathSync } from 'fs';
import { mergeAndConcat } from 'merge-anything';
import { createRequire } from 'module';
import {
  createDevAssetResolver,
  registerDevAssetResolver,
  installDevManifestBridge,
  devManifestBridgeUrl,
  DEV_MANIFEST_REGISTRY_KEY,
} from './dev-manifest.js';
import { boundaryModules } from './boundary-modules.js';
import { solidDiagnostics } from './diagnostics/index.js';
import {
  resolvePerformanceTracksOptions,
  solidPerformanceTracks,
  type PerformanceTracksOption,
} from './performance-tracks/index.js';

import {
  normalizeServerFunctionsEndpoint,
  serverFunctions,
  type ServerFunctionsOptions,
} from './server-functions/index.js';
import { SSR_HANDLER_ID, startServe, type StartOptions } from './ssr/index.js';
import { startEnv } from './start-env.js';
import {
  cleanModuleId,
  isTsrxCssModule,
  isTsrxModule,
  offsetSourceMapLine,
  prependTsrxCssImport,
  resolvedTsrxCssModuleId,
  resolveTsrxCssModule,
  tsrxCssSourceId,
  updateTsrxCss,
} from './tsrx.js';

export { devStylePatch } from './dev-manifest.js';
export { serverFunctions };
export type { ServerFunctionsOptions };
export type {
  PersistedServerFunctionManifest,
  ServerFunctionsFilter,
} from './server-functions/index.js';
export type { StartOptions };
export type { StartMiddleware } from './request-event.js';
import path from 'path';
import type { FilterPattern, Logger, Plugin, ViteDevServer } from 'vite';
import {
  createFilter,
  defaultClientConditions,
  defaultExternalConditions,
  defaultServerConditions,
  transformWithOxc,
} from 'vite';
import { getEnvironmentConsumer, isRunnableEnvironment } from './environment.js';
import { crawlFrameworkPkgs } from 'vitefu';

/**
 * The `lazy()` module-URL placeholder contract, shared with the native
 * compiler's `transformLazy` pass: `lazy(() => import("spec"))` calls gain a
 * second string-literal argument of the form
 * `"__SOLID_LAZY_MODULE__:" + spec`, which `resolveLazyModuleUrls` swaps for
 * the project-relative resolved module path. The prefix and shape are FROZEN
 * — the emitting side lives in @solidjs/compiler and must match.
 */
const LAZY_PLACEHOLDER_PREFIX = '__SOLID_LAZY_MODULE__:';

/**
 * The HMR runtime: the dev-only `solid-js/refresh` core entry. Refresh
 * wrappers are compiled by the native `transformRefresh` pass in every mode
 * and import the runtime through normal module resolution (the legacy
 * solid-refresh package — whose runtime carries a known Solid 2.0 HMR bug,
 * solid-refresh#85 — is no longer used at all).
 */
const REFRESH_RUNTIME_SOURCE = 'solid-js/refresh';

// Appended to the document shell's client compile instead of a refresh
// boundary (see documentModuleId in solidPlugin): self-accept, then
// invalidate — Vite's spelling for "this module cannot hot-update, reload".
const DOCUMENT_HMR_DECLINE =
  '\nif (import.meta.hot) {\n  import.meta.hot.accept(() => import.meta.hot.invalidate());\n}\n';

const DEFAULT_STYLE_EXCLUDE = /node_modules/;

const VIRTUAL_MANIFEST_ID = 'virtual:solid-manifest';
const RESOLVED_VIRTUAL_MANIFEST_ID = '\0' + VIRTUAL_MANIFEST_ID;

// In dev the virtual manifest exports a `{ resolve, resolveSync }` resolver:
// lazy modules resolve to their dev URL plus transitively imported CSS as
// inline-style descriptors collected from the live module graph. The resolver
// itself lives plugin-side (it closes over the dev server) and is reached
// through a global registry; isolated module runners that don't share
// globals (nitro's dev worker, workerd) fall back to fetching the dev
// server's bridge endpoint, whose URL is baked in at generation time
// (`bridgeUrl` — null outside a live dev server, e.g. the manifest-less SSR
// build fallback, where js-only resolution remains). Bridge failures log
// loudly and resolve to null so the runtime's own no-assets warning stays
// the final catch-all.
//
// The generated `moduleUrl` mirrors `devModuleUrl` (src/dev-manifest.ts) —
// base-prefixed root-relative URLs, `/@fs/` for root-external keys — for the
// degraded paths that can't reach the plugin-side resolver (no registry and
// no bridge, or a resolveSync call before the bridge cache warms). Keep the
// two in sync.
const devManifestCode = (root: string, base: string, bridgeUrl: string | null) => `const registry = globalThis[Symbol.for(${JSON.stringify(
  DEV_MANIFEST_REGISTRY_KEY,
)})];
const projectRoot = ${JSON.stringify(root.split(path.sep).join('/'))};
const base = ${JSON.stringify(base.startsWith('/') ? base.replace(/\/$/, '') : '')};
function moduleUrl(key) {
  key = key.replace(/^\\/+/, "");
  const queryIndex = key.indexOf("?");
  const file = queryIndex === -1 ? key : key.slice(0, queryIndex);
  const query = queryIndex === -1 ? "" : key.slice(queryIndex);
  if (file.slice(0, 2) !== "..") return base + "/" + key;
  const segments = (projectRoot + "/" + file).split("/");
  const resolved = [];
  for (const segment of segments) {
    if (segment === "..") resolved.pop();
    else if (segment && segment !== ".") resolved.push(segment);
  }
  return base + "/@fs/" + resolved.join("/") + query;
}
const jsOnly = key => ({ js: [moduleUrl(key)], css: [] });
const bridgeUrl = ${JSON.stringify(bridgeUrl)};
function createBridgeResolver() {
  // Convergence cache, mirroring the in-process resolver: server-side lazy()
  // re-requests assets on every retry of a suspended render pass, and only a
  // synchronous answer lets the pass converge (a fresh promise per call
  // suspends every retry anew — nested routes then loop until the render
  // stack overflows). Cached entries can go stale after a CSS edit (no
  // watcher reaches this side of the bridge); the HMR client replaces SSR'd
  // dev styles on load, so staleness self-heals at hydration. Only successful
  // answers are cached: a null (bridge failure) must stay retryable, or one
  // transient miss would strip the module's client assets — silently — for
  // the rest of the dev session. In-flight dedupe still gives retries of the
  // same pass a stable promise, so convergence holds either way.
  const cache = new Map();
  const inFlight = new Map();
  return {
    resolve(key) {
      const cached = cache.get(key);
      if (cached) return cached;
      let request = inFlight.get(key);
      if (!request) {
        request = fetchAssets(key).then(
          (assets) => {
            if (assets) cache.set(key, assets);
            inFlight.delete(key);
            return assets;
          },
          (error) => {
            inFlight.delete(key);
            throw error;
          },
        );
        inFlight.set(key, request);
      }
      return request;
    },
    resolveSync: (key) => cache.get(key) || jsOnly(key),
  };
}
async function fetchAssets(key) {
  const url = new URL(bridgeUrl);
  url.searchParams.set("key", key);
  let response;
  try {
    response = await fetch(url);
  } catch (error) {
    console.error(
      '[@solidjs/vite-plugin] Dev manifest bridge request failed for module key "' + key +
        '" (' + url.href + '): ' + ((error && error.message) || error) +
        ". SSR will render without this module's client assets, so its hydration preload entry will be missing.",
    );
    return null;
  }
  if (!response.ok) {
    // A silent null here strips the module's client assets from the
    // SSR'd hydration asset map and hydration fails much later with a
    // cryptic client-side error — report the miss where it happens.
    console.error(
      '[@solidjs/vite-plugin] Dev manifest bridge request failed with status ' + response.status +
        ' for module key "' + key + '" (' + url.href +
        "). SSR will render without this module's client assets, so its hydration preload entry will be missing.",
    );
    return null;
  }
  return response.json();
}
export default (registry && registry[${JSON.stringify(root)}]) ||
  (bridgeUrl ? createBridgeResolver() : { resolve: jsOnly, resolveSync: jsOnly });`;

/** Possible options for the extensions property */
export interface ExtensionOptions {
  typescript?: boolean;
}

export type Compiler = 'babel' | 'native';
/**
 * Which source names are carried into output for the dev and observe
 * runtimes to label the reactive graph with (see
 * `Options.solid.sourceNames`). Each kind defaults to the posture: on for
 * dev and `observe`, off for production builds. `components` and `bindings`
 * are the JSX compiler's `sourceNames` option; `primitives` is the native
 * compiler's standalone `transformSourceNames` pass, which the plugin runs
 * on every module — babel apps included.
 */
export interface SourceNamesOptions {
  /** `createComponent(Home, props, "Home")` — owners labelled `<Home>`. */
  components?: boolean;
  /** Binding effects named by what they write: `span.textContent`, `div.children`. */
  bindings?: boolean;
  /**
   * Primitives named after the identifier they are declared as —
   * `createSignal(0, { name: "count" })`, `createCounter.value` inside a
   * composed primitive — by the native compiler's `transformSourceNames`
   * pass. Runs on `.ts`/`.js` modules as well as components (outside
   * node_modules), whichever JSX compiler the app uses.
   */
  primitives?: boolean;
}

export type SolidOptions = Omit<JsxCompilerOptions, 'filename' | 'sourceMap' | 'sourceNames'> & {
  /**
   * Source names in output: `true`/`false` for every kind, or per kind.
   * Defaults to the posture — on for dev and `observe`, off for production
   * builds; `false` opts out of every kind, in dev too.
   */
  sourceNames?: boolean | SourceNamesOptions;
};
type NativeCompiler = typeof import('@solidjs/compiler');
let nativeCompilerPromise: Promise<NativeCompiler> | undefined;

async function loadNativeCompiler() {
  try {
    return await (nativeCompilerPromise ??= import('@solidjs/compiler'));
  } catch (error) {
    nativeCompilerPromise = undefined;
    const reason = error instanceof Error ? `\n\nCause: ${error.message}` : '';
    throw new Error(
      '@solidjs/vite-plugin: failed to load @solidjs/compiler, which is required ' +
        'in every mode (it drives the lazy, refresh, and server-function transforms; ' +
        'compiler: "babel" only switches the JSX transform). Your platform should get ' +
        'a prebuilt native binary or the @solidjs/compiler-wasm32-wasi fallback ' +
        '— check that optional dependencies were installed.' +
        reason,
    );
  }
}

/** Configuration options for @solidjs/vite-plugin. */
export interface Options {
  /**
   * A [picomatch](https://github.com/micromatch/picomatch) pattern, or array of patterns, which specifies the files
   * the plugin should operate on. Relative patterns are resolved against the
   * Vite root, not the invocation directory.
   */
  include?: FilterPattern;
  /**
   * A [picomatch](https://github.com/micromatch/picomatch) pattern, or array of patterns, which specifies the files
   * to be ignored by the plugin. Relative patterns are resolved against the
   * Vite root, not the invocation directory.
   */
  exclude?: FilterPattern;
  /**
   * Resolve Solid's development builds under `vite dev` — the `development`
   * export condition of `solid-js` and `@solidjs/web`, which carry the extra
   * checks, warnings and diagnostics. Has no effect on `vite build`. Set to
   * `false` to serve the production builds in dev instead.
   *
   * @default true
   */
  dev?: boolean;
  /**
   * Resolve Solid's observe builds: the production-speed runtime that keeps
   * the diagnostics and attribution channels (`OBSERVE`) alive for
   * production observability tooling. Adds the `observe` export condition
   * to every environment (client and server, inlined and externalized) and
   * turns on the compiler's `sourceNames` (components, bindings, and
   * primitives) so graph labels survive minification. Applies to `vite
   * build` and preview; under `vite dev` the
   * `development` condition still wins (the dev build is a superset).
   *
   * @default false
   */
  observe?: boolean;
  /**
   * Dev-serve only: expose Solid's diagnostic and attribution channels to
   * out-of-process consumers (agents, tests, curl). Injects a client module
   * that installs the in-page bridge from the app's own
   * `@solidjs/diagnostics`, and serves a `/__solid/diagnostics` endpoint on
   * the dev server that forwards capture control (`begin`/`end`),
   * `whyDidRun`, and cost queries to the page over the Vite WebSocket. No
   * effect on builds or preview.
   *
   * Omitted (the default), the surface auto-enables when the app declares
   * `@solidjs/diagnostics` in its package.json — adding the dev dependency
   * is the whole setup. `true` forces it on (erroring if the package is
   * missing); `false` opts out entirely. Never active in test mode
   * (vitest) or on builds/preview.
   *
   * @default undefined (auto-detect)
   */
  diagnostics?: boolean;
  /**
   * Dev-serve only: paint Solid's records — re-runs, interactions, holds,
   * async flights, navigations, server-function calls — as custom tracks
   * in the Chrome Performance panel (`@solidjs/web/performance-tracks`),
   * without the app calling `enablePerformanceTracks()` itself. Injects a
   * client module that enables the tracks ahead of the app's entry (a
   * `<head>` script for index.html apps, an import at the top of the
   * start-mode client entry), so hydration and the first interaction are
   * on the timeline. The dev server already writes its side of the work
   * (`Server-Timing`), which the tracks read back.
   *
   * Omitted or `true` enables under `vite dev` with the adapter's defaults;
   * an object enables with those options passed through
   * (`PerformanceTracksOptions` from `@solidjs/web/performance-tracks`:
   * `minMs`, `rich`, `attribution` — plain data, serialized into the
   * injected module); `false` opts out. Never active on `vite build` —
   * not for `dev: true` or `observe` builds (an observe app enables its
   * own tracks in production) — in test mode (vitest), or on preview.
   * With `dev: false` (and no `observe`) the production runtime is served
   * and the adapter is a no-op.
   *
   * @default true
   */
  performanceTracks?: PerformanceTracksOption;
  /**
   * Whether the app is server-rendered — one meaning everywhere.
   *
   * Without {@link start}: the legacy transform-only flag, unchanged.
   * `true` enables the SSR transforms (hydratable client code, SSR server
   * code) — you provide the entries and the server yourself.
   *
   * With {@link start}: selects the start mode. `true` is SSR start mode
   * (per-request streaming render + hydration); `false`/omitted is client
   * mode (a static document shell + client-side `render()`). Flipping a
   * start-mode project between SPA and SSR is toggling this one boolean.
   *
   * The flag describes the app's initial document, not the internal
   * pipelines — client mode still compiles the document shell through the
   * SSR transforms to serve/prerender it.
   *
   * Objects are no longer accepted: start-mode options moved to {@link start}
   * (`ssr: { ... }` from 3.0.0-next.23 and earlier becomes
   * `start: { ... }, ssr: true`).
   *
   * @default false
   */
  ssr?: boolean;

  /**
   * Start mode — Start as a mode of the plugin: it owns entries, dev
   * serving, and the build — no index.html, no mount file, no server
   * wiring. `start: true` is the zero-config spelling, sugar for the empty
   * options bag `start: {}` (both mean the identical start mode with
   * defaults; `false`/absent is off). Conventions (shared by both modes,
   * so projects flip between them by toggling {@link ssr}): `src/App.*`
   * (or `start.app`) is the root component; `src/Document.*` (or
   * `start.document`) is the optional document shell; authored
   * `src/entry-server.*` / `src/entry-client.*` (or `start.entryServer` /
   * `start.entryClient`) replace the generated entries.
   *
   * With `ssr: true` — SSR start mode:
   *
   * - Dev: a middleware on the Vite dev server streams the rendered app for
   *   HTML-accepting GET requests — `vite` just works, no server file.
   * - Build: a plain `vite build` produces both bundles (client to
   *   `dist/client`, server to `dist/server` via the environments/builder
   *   API). The server bundle's entry is `virtual:solid-ssr-handler`, whose
   *   `handleRequest(request)` export maps a web `Request` to a streamed
   *   `Response`; its default `{ fetch(request) }` export provides the same
   *   handler in the Fetchable shape used by deployment integrations.
   *   The normal `ssr` environment exposes it as the `index` service entry
   *   so provider Vite plugins can supply the runtime and build orchestration.
   * - `start.node: true` additionally emits a ready-to-run Node server,
   *   `dist/server/node.js` (`node dist/server/node.js`; PORT/HOST), that
   *   serves the client build statically and dispatches the rest through
   *   `handleRequest` — see {@link StartOptions.node}. Node is the one
   *   mainstream runtime without a fetch-shaped server API; every other
   *   host consumes the `{ fetch }` export directly.
   * - With `serverFunctions` also enabled, the prod handler serves the
   *   server-function endpoint too (in dev the server-function middleware
   *   already runs first).
   *
   * Without `ssr: true` — client mode:
   *
   * - Dev: every HTML-accepting GET streams the rendered document shell
   *   (without the app — history-fallback semantics); the generated client
   *   entry `render()`s the app into it.
   * - Build: `vite build` emits a static `dist/client` — the shell is
   *   prerendered once through the built handler into
   *   `dist/client/index.html` with the hashed entry script and CSS links —
   *   deployable to any static host. No server bundle remains unless
   *   `serverFunctions` is enabled, in which case `dist/server` is kept and
   *   its `handleRequest` serves the endpoint (pages stay static) — and
   *   `start.node` then emits `dist/server/node.js` serving the static
   *   client with an `index.html` history fallback plus the endpoint.
   * - Client code stays non-hydratable (`generate: 'dom'`), exactly like a
   *   plain SPA; server-only options (`entryServer`, `external`) are inert.
   * - `vite preview` serves the static build with history fallback (and
   *   dispatches the server-function endpoint through the kept handler).
   *
   * @default undefined
   */
  start?: boolean | StartOptions;

  /**
   * JSX compiler backend to use. The default `"native"` compiles through
   * `@solidjs/compiler`; `"babel"` is the escape hatch running
   * `@solidjs/babel-plugin` instead — if native output ever differs from your
   * expectations, set `compiler: "babel"` and file an issue (the behavioral
   * diff between the modes is the bug report). Platforms without a prebuilt
   * native binary (e.g. StackBlitz WebContainers) automatically use the wasm
   * fallback; the compiler package itself is required in every mode.
   *
   * @default "native"
   */
  compiler?: Compiler;

  /**
   * This will inject HMR runtime in dev mode. Has no effect in prod. If
   * set to `false`, it won't inject the runtime in dev.
   *
   * @default true
   * @deprecated use `refresh` instead
   */
  hot?: boolean;
  /**
   * This registers additional extensions that should be processed by
   * @solidjs/vite-plugin. Experimental `.tsrx` is always registered as
   * TypeScript TSRX and does not need to be listed here.
   *
   * @default undefined
   */
  extensions?: (string | [string, ExtensionOptions])[];
  /**
   * Pass any additional babel transform options. They will be merged with
   * the transformations required by Solid.
   *
   * Note: with `compiler: "native"` the plugin is normally fully Babel-free
   * (native lazy/refresh/JSX passes). Supplying custom babel options
   * reintroduces a Babel support pass ahead of the native JSX transform to
   * host them. For `.tsrx` only, native TSRX lowering runs first and the
   * support pass receives the generated ordinary JavaScript.
   *
   * @default {}
   */
  babel?:
    | babel.TransformOptions
    | ((source: string, id: string, ssr: boolean) => babel.TransformOptions)
    | ((source: string, id: string, ssr: boolean) => Promise<babel.TransformOptions>);
  /**
   * Pass any additional [@solidjs/babel-plugin](https://github.com/solidjs/solid/tree/main/packages/babel-plugin) options.
   * They will be merged with the plugin's Solid defaults.
   *
   * @default {}
   */
  solid?: SolidOptions;

  /**
   * Enable `"use server"` server function compilation (experimental). Pass
   * `true` for the defaults (runtime from @solidjs/web/server-functions) or
   * an options object to customize. The directive transform sub-plugins are
   * emitted ahead of the JSX transform in the returned plugin array.
   *
   * Zero-config setup: in dev, a middleware on the Vite server handles the
   * endpoint (default `/_server`, joined with `base`) end to end — no
   * server-function code needed in the server entry. For production SSR
   * builds, import `virtual:solid-server-function-handler` in the server
   * entry and mount its `handleServerFunctionRequest(request)` export on the
   * endpoint; it eagerly imports every module containing server functions so
   * registrations survive tree-shaking.
   *
   * Hosts whose own server environment should own endpoint dispatch in dev
   * (e.g. @cloudflare/vite-plugin, so functions run in workerd with
   * bindings) can keep this option and set
   * `serverFunctions: { devMiddleware: false }` — see
   * {@link ServerFunctionsOptions.devMiddleware}. A server-only module can
   * be pinned into the handler graph for pre-dispatch runtime registration
   * via {@link ServerFunctionsOptions.configure}.
   *
   * Meta-frameworks that need to control plugin ordering themselves (e.g.
   * relative to a file-system router) and dispatch requests through their
   * own server should use the standalone `serverFunctions()` export instead,
   * which never installs the dev middleware.
   *
   * The object form's `components` flag additionally enables server
   * components (experimental) — `"use server"` functions returning a
   * component, served over the same endpoint. They come essentially for
   * free: the endpoint transform is installed automatically, and with
   * SSR start mode (the `start` option with `ssr: true`) and generated entries
   * the document wiring is emitted too. See
   * {@link ServerFunctionsOptions.components}.
   *
   * @default undefined
   */
  serverFunctions?: boolean | ServerFunctionsOptions;

  /** Options for the solid-refresh HMR transform (dev only). */
  refresh?: RefreshOptions;
}

/** Options for the solid-refresh HMR transform (dev only). */
export interface RefreshOptions {
  /**
   * Disable the refresh transform entirely (equivalent to the deprecated
   * `hot: false`).
   */
  disabled?: boolean;
  /**
   * Emit per-component `signature`/`dependencies` metadata so edits only
   * remount components whose code actually changed.
   *
   * @default true
   */
  granular?: boolean;
}

function getExtension(filename: string): string {
  const index = filename.lastIndexOf('.');
  return index < 0 ? '' : filename.substring(index).replace(/\?.+$/, '');
}
// The packages whose dev/production server builds are selected by the
// `development` export condition. A dependency on either means the package
// consumes the runtime and must resolve it through Vite in dev.
const SOLID_RUNTIME_PKGS = ['solid-js', '@solidjs/web'];

// Tooling that declares solid-js as a peer but never runs inside the SSR
// module runner. Kept out of the crawl entirely: classifying them as
// semi-framework would also crawl THEIR dependencies, which vitefu deep-
// includes in the client optimizer (`@solidjs/vite-plugin > @babel/core`
// pre-bundled for the browser — ~2.6 MB of dead weight per cold start).
// Mirrors vite-plugin-svelte's isCommonDepWithoutSvelteField list.
const NON_RUNTIME_SOLID_PKGS = ['@solidjs/vite-plugin', 'vite', 'vitest', 'eslint-plugin-solid'];
const NON_RUNTIME_SOLID_PREFIXES = [
  'vite-plugin-',
  'eslint-plugin-',
  'prettier-plugin-',
  '@types/',
];
function isNonRuntimeSolidPkg(name: string): boolean {
  const bare = name.slice(name.lastIndexOf('/') + 1);
  return (
    NON_RUNTIME_SOLID_PKGS.includes(name) ||
    NON_RUNTIME_SOLID_PREFIXES.some((p) => (p.startsWith('@') ? name : bare).startsWith(p))
  );
}

function containsSolidField(fields: Record<string, any>) {
  const keys = Object.keys(fields);
  for (let i = 0; i < keys.length; i++) {
    const key = keys[i];
    if (key === 'solid') return true;
    if (typeof fields[key] === 'object' && fields[key] != null && containsSolidField(fields[key]))
      return true;
  }
  return false;
}

/**
 * Locate a bare package the way Vite (and Node without `NODE_PATH`) does: walk
 * `<dir>/node_modules/<name>` up from `root`. `require.resolve` can't be used
 * for this — it also consults `NODE_PATH`, which pnpm's bin shims (`pnpm
 * vitest`, `pnpm test`) point at the hoisted virtual store
 * (`node_modules/.pnpm/node_modules`), where every transitive dependency of the
 * whole tree is reachable.
 */
function findPackageDir(name: string, root: string): string | undefined {
  let dir = root;
  while (true) {
    const candidate = path.join(dir, 'node_modules', name);
    if (existsSync(path.join(candidate, 'package.json'))) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

/**
 * Whether `id` looks like a package specifier (`name`, `name/sub`,
 * `@scope/name/sub`), by syntax alone. Relative and absolute paths, ids with a
 * protocol or drive (`virtual:`, `node:`, `C:`), subpath imports (`#x`) and
 * aliases like `~/x` or `@/x` don't.
 */
function isPackageSpecifier(id: string): boolean {
  if (!id || /^[./\\#~\0]/.test(id) || id.includes(':')) return false;
  if (id.startsWith('@')) return /^@[^/]+\/[^/]/.test(id);
  return true;
}

function getJestDomExport(setupFiles: string[], root: string) {
  if (setupFiles?.some((file) => /jest-dom/.test(file))) return undefined;

  // Resolve from the project root, not from this plugin's own location. With pnpm's
  // isolated node_modules layout the plugin can reach a jest-dom that only exists as a
  // transitive dependency (e.g. of Storybook), while Vitest resolves `setupFiles` from the
  // project root, where it isn't installed, and fails to load it.
  // https://github.com/solidjs/solid-vite-plugin/issues/231
  // The bare specifier (not the resolved path) is injected on purpose: `require.resolve` picks
  // jest-dom's CommonJS entry, which Vitest refuses to load, while Vitest itself resolves the
  // specifier to the ESM entry.
  const packageDir = findPackageDir('@testing-library/jest-dom', root);
  if (!packageDir) return undefined;
  // Check the subpath against THIS copy: resolving from inside the package
  // self-references its `exports` map (v6+), or falls back to its own files
  // for versions without one (v5's `extend-expect`). `NODE_PATH` still
  // participates in that lookup, so make sure the hit landed in the package
  // Vite will resolve rather than in some hoisted copy of another version.
  const realPackageDir = realpathSync(packageDir);
  const packageRequire = createRequire(path.join(packageDir, 'package.json'));
  return ['@testing-library/jest-dom/vitest', '@testing-library/jest-dom/extend-expect'].find(
    (specifier) => {
      try {
        const resolved = realpathSync(packageRequire.resolve(specifier));
        return resolved.startsWith(realPackageDir + path.sep);
      } catch (e) {
        return false;
      }
    },
  );
}

function getSolidOptions(
  options: Partial<Options>,
  isSsr: boolean,
  dev: boolean,
  observe: boolean,
  isTestMode = false,
): SolidOptions {
  let solidOptions: Pick<SolidOptions, 'generate' | 'hydratable'>;

  if (isTestMode) {
    // Vitest compiles with the client posture regardless of the app's `ssr`
    // flag: component tests exercise DOM code and nothing hydrates in a
    // test, so hydratable output would look for markers that aren't there.
    // `generate` still follows the transform's own ssr flag, so explicit
    // node-environment tests (renderToString) keep their server codegen.
    solidOptions = { generate: isSsr ? 'ssr' : 'dom', hydratable: false };
  } else if (options.start && !options.ssr) {
    // Client start mode: client code compiles exactly like a plain SPA
    // (dom, non-hydratable — nothing hydrates); only the document shell
    // render goes through the SSR transforms, also non-hydratable since
    // the shell is inert HTML the client never claims.
    solidOptions = { generate: isSsr ? 'ssr' : 'dom', hydratable: false };
  } else if (options.ssr) {
    if (isSsr) {
      solidOptions = { generate: 'ssr', hydratable: true };
    } else {
      solidOptions = { generate: 'dom', hydratable: true };
    }
  } else {
    solidOptions = { generate: 'dom', hydratable: false };
  }

  // Server components (serverFunctions.components) turn on the SSR-side
  // attribute-slot transform: ref/on* positions on intrinsic elements
  // compile to one guarded `ssrClaim` hole per element instead of dropping
  // (the runtime marks them `_s:on:<event>` / `_s:ref` for the client
  // frame's slot reads), a dynamic `class`/`style` compiles to a
  // whole-attribute `ssrElementAttribute` hole so a client attribute slot
  // can own it, and a spread element's named ref/on* ride `ssrElement`'s
  // trailing `claims` thunk. That is the 2.0.0-rc.13 compiler ↔ runtime
  // contract (the earlier `_bnd` marker is gone; rc.12 was never
  // published), which is why the compiler and runtime floors move
  // together. SSR-only by construction (the dom generate ignores the
  // flag), and apps without the flag compile byte-for-byte as before.
  const serverComponents =
    typeof options.serverFunctions === 'object' && !!options.serverFunctions.components;

  // Solid-specific defaults (moduleName "@solidjs/web", the control-flow
  // builtIns, contextToCustomElements, wrapConditionals) are baked into both
  // backends — @solidjs/compiler and @solidjs/babel-plugin — so only the
  // posture this plugin actually decides is passed.
  // Source names: the dev and observe runtimes label each component's owner
  // (`<Home>`) and each compiled binding effect (`span.textContent`) for
  // diagnostics and attribution paths. Without the compiler carrying the
  // source names, a minified build labels owners by whatever the minifier
  // left of `Comp.name` and bindings as `effect`. Both generates emit the
  // component name — the ssr generate from the compilers that carry
  // solidjs/solid#3441 (2.0.0-rc.9), so server findings and boundary
  // records locate by component too — and the production runtime ignores
  // the arguments, so they are only emitted for the postures whose runtime
  // reads them. Primitive names are the separate transformSourceNames pass
  // (see getSourceNames / the transform hook), not a JSX-compiler option.
  //
  // The compilers default their own `sourceNames` on under `dev` (rc.10), so
  // the resolved value is always passed — `false` when both kinds are off —
  // and the plugin's table below, not the compiler default, decides. That is
  // what makes `solid.sourceNames: false` an opt-out in dev rather than a
  // no-op.
  const { sourceNames: _userSourceNames, ...userSolidOptions } = options.solid || {};
  const { components, bindings } = getSourceNames(options, dev, observe);
  return {
    ...solidOptions,
    ...(serverComponents && solidOptions.generate === 'ssr' ? { serverComponents: true } : {}),
    dev,
    sourceNames: components || bindings ? { components, bindings } : false,
    ...userSolidOptions,
  };
}

/**
 * Resolve `solid.sourceNames` to one flag per kind — `components` and
 * `bindings` go to the JSX compiler, `primitives` gates the standalone
 * `transformSourceNames` pass in the transform hook.
 *
 * The default follows the posture. `dev` here is the same flag the compilers
 * receive as `dev` (`options.dev`, which defaults to on under `vite dev` and
 * off for `vite build`), and `observe` is `options.observe`; those are the
 * two runtimes that read the names, and the production runtime ignores them.
 *
 * | `solid.sourceNames`     | dev or observe            | production                 |
 * | ----------------------- | ------------------------- | -------------------------- |
 * | (unset)                 | all on                    | all off                    |
 * | `true`                  | all on                    | all on                     |
 * | `false`                 | all off                   | all off                    |
 * | `{ kind: true/false }`  | as given; the rest on     | as given; the rest off     |
 */
function getSourceNames(
  options: Partial<Options>,
  dev: boolean,
  observe: boolean,
): Required<SourceNamesOptions> {
  const posture = dev || observe;
  const user = options.solid?.sourceNames;
  if (typeof user === 'boolean') return { components: user, bindings: user, primitives: user };
  return {
    components: user?.components ?? posture,
    bindings: user?.bindings ?? posture,
    primitives: user?.primitives ?? posture,
  };
}

/**
 * The `sourceNames.primitives` pass is plain JavaScript in and out, so it
 * also applies to the `.ts`/`.js` modules primitives are composed in — the
 * ids the JSX transform gate below would otherwise return early for. A
 * `.d.ts` has nothing to name.
 */
const PRIMITIVES_ONLY_MODULE = /\.[mc]?[jt]s$/i;
const DECLARATION_MODULE = /\.d\.[mc]?ts$/i;
/**
 * Cheap pre-check ahead of the native call: the pass only names calls that
 * resolve to imports from these modules, so source without either string
 * cannot change.
 */
const PRIMITIVE_SOURCES = ['solid-js', '@solidjs/signals'];

let warnedMissingSourceNamesPass = false;

/**
 * Run the compiler's `transformSourceNames` pass, or leave the code alone
 * (warning once) on a compiler predating it — the pass is a default-on
 * nicety for dev/observe, not something to fail a build over.
 */
async function transformPrimitiveNames(
  ctx: { warn(message: string): void },
  compiler: NativeCompiler,
  code: string,
  filename: string,
): Promise<{ code: string; map: ChainableMap } | null> {
  if (!PRIMITIVE_SOURCES.some((source) => code.includes(source))) return null;
  if (typeof compiler.transformSourceNamesAsync !== 'function') {
    if (!warnedMissingSourceNamesPass) {
      warnedMissingSourceNamesPass = true;
      ctx.warn(
        '@solidjs/vite-plugin: the installed @solidjs/compiler has no transformSourceNames ' +
          'pass, so primitives keep their generic labels (`signal`, `computed`) in ' +
          'diagnostics. Update @solidjs/compiler, or set `solid.sourceNames.primitives: false`.',
      );
    }
    return null;
  }
  const result = await compiler.transformSourceNamesAsync(code, { filename, sourceMap: true });
  // Nothing to name: the pass hands the source back verbatim, with no map.
  if (result.code === code) return null;
  return { code: result.code, map: result.map };
}

async function getBabelUserOptions(
  options: Partial<Options>,
  source: string,
  id: string,
  isSsr: boolean,
) {
  if (!options.babel) return {};
  if (typeof options.babel !== 'function') return options.babel;

  const babelOptions = options.babel(source, id, isSsr);
  return babelOptions instanceof Promise ? await babelOptions : babelOptions;
}

function normalizeSourceMap(
  map: string | babel.TransformOptions['inputSourceMap'] | null | undefined,
) {
  if (typeof map === 'string') return JSON.parse(map);
  return map || null;
}

type ChainableMap = string | babel.TransformOptions['inputSourceMap'] | null | undefined;

/**
 * Merges the sourcemaps of sequential whole-file transforms (given in
 * application order, earliest first) into one map tracing back to the
 * original source.
 */
function combineSourcemaps(maps: ChainableMap[]) {
  const chain = maps.filter((map): map is NonNullable<ChainableMap> => !!map);
  if (chain.length === 0) return null;
  if (chain.length === 1) return normalizeSourceMap(chain[0]);
  // remapping expects most-recent-first.
  return JSON.parse(remapping(chain.reverse() as any, () => null).toString());
}

function toPosixPath(p: string): string {
  return p.split(path.sep).join('/');
}

function tryRealpath(p: string): string | null {
  try {
    return realpathSync.native(p);
  } catch {
    return null;
  }
}

/** The `input` a build environment's config resolves to, in any spelling. */
function configuredBuildInput(build: any): unknown {
  if (!build) return undefined;
  return build.rolldownOptions?.input ?? build.rollupOptions?.input ?? build.lib?.entry;
}

/**
 * The genuine entries of a client build, derived from its configured input
 * (`build.rollupOptions.input` as a string / array / record, or Vite's
 * default `index.html`). Rollup and rolldown only ever flag two kinds of
 * chunk `isEntry`: those facades and chunks plugins emit with
 * `emitFile({ type: 'chunk' })` — so this is exactly the knowledge that
 * tells a real application entry apart from an emitted lazy facade.
 *
 * `moduleIds` — every spelling the entry's facade module id can take: as
 * written (virtual ids resolve to themselves), resolved against the root
 * (Vite resolves relative file inputs there), and the real path of either
 * (Vite's resolver follows symlinks).
 * `manifestKeys` — the manifest.json keys Vite derives from those facades
 * (root-relative, `\0` stripped), matching Vite's own `getChunkName`.
 */
function resolveConfiguredEntries(input: unknown, root: string) {
  const raw: string[] =
    input == null
      ? ['index.html']
      : typeof input === 'string'
        ? [input]
        : Array.isArray(input)
          ? input
          : Object.values(input as Record<string, unknown>);
  const moduleIds = new Set<string>();
  for (const id of raw) {
    if (typeof id !== 'string') continue;
    const clean = id.replace(/\0/g, '');
    const candidates = [clean, path.resolve(root, clean)];
    for (const candidate of candidates) {
      moduleIds.add(candidate);
      moduleIds.add(toPosixPath(candidate));
      const real = tryRealpath(candidate);
      if (real) {
        moduleIds.add(real);
        moduleIds.add(toPosixPath(real));
      }
    }
  }
  const manifestKeys = new Set<string>();
  for (const id of moduleIds) manifestKeys.add(toPosixPath(path.relative(root, id)));
  return {
    moduleIds,
    manifestKeys,
    isEntryModule(id: string | null | undefined): boolean {
      if (!id) return false;
      const clean = id.replace(/\0/g, '');
      if (moduleIds.has(clean) || moduleIds.has(toPosixPath(clean))) return true;
      const real = tryRealpath(clean);
      return !!real && (moduleIds.has(real) || moduleIds.has(toPosixPath(real)));
    },
  };
}

interface NormalizeLazyEntriesOptions {
  /**
   * Is this record a genuine configured entry? Such records keep `isEntry`
   * no matter what dynamically imports them.
   */
  isConfiguredEntry: (key: string, record: any) => boolean;
  /**
   * Records already known to be emitted lazy facades (reclassified
   * explicitly by their emit references); everything else the sweep strips
   * is reported through `warn` because it could be an entry the input
   * matching missed.
   */
  knownLazyKeys?: Set<string>;
  warn?: (message: string) => void;
  /**
   * Also flag dynamic-import targets that already lost `isEntry` as
   * `isDynamicEntry` — repairs the flag rolldown drops (see below) on the
   * serialized manifest.
   */
  repairDynamicEntries?: boolean;
}

/**
 * Chunks emitted for lazy() targets are marked `isEntry` by Rollup even
 * though they are semantically dynamic entries. Reclassify any entry that is
 * dynamically imported by another chunk so the runtime's entry-asset
 * detection (which keys off `isEntry`) can't pick a lazy facade instead of
 * the real client entry. Works on both the Vite manifest.json shape and the
 * raw Rollup output bundle — both key entries by name and expose
 * `dynamicImports` / `isEntry` with the same meaning.
 *
 * Being a dynamic-import target alone does not make a chunk a lazy facade,
 * though: the real client entry becomes one whenever it absorbs a module
 * that is also dynamically imported somewhere else. Solid 2 produces that
 * shape on its own — `@solidjs/web/frames/client` lazily imports the
 * serialization decoder (`loadCodec()`), so a static import of
 * `@solidjs/web/serialization/decode` anywhere in the client graph merges
 * the decoder into the entry chunk, and the entry then lists itself (or is
 * listed by another lazy chunk) under `dynamicImports`. Stripping `isEntry`
 * there leaves the bundle with no entry at all ("No entry file found"
 * downstream, e.g. TanStack Start's manifest capture, #342). Genuine
 * configured entries are therefore never reclassified, and a chunk's
 * dynamic import of itself is not an edge worth acting on.
 *
 * Rolldown caveat: of the flags written here only `isEntry` is synced back
 * to the native bundle after the hook (rolldown's `update_output_chunk`
 * copies `code`, `map`, `imports`, `dynamicImports`, `isEntry` and the file
 * name; `isDynamicEntry` is kept from the original chunk). Later plugins
 * and Vite's manifest plugin therefore see reclassified facades as neither
 * entry nor dynamic entry under rolldown. The manifest `load` path repairs
 * `isDynamicEntry` on the plugin's own manifest module, the one place it
 * controls end to end.
 */
function normalizeEmittedLazyEntries(
  manifest: Record<string, any>,
  { isConfiguredEntry, knownLazyKeys, warn, repairDynamicEntries }: NormalizeLazyEntriesOptions,
) {
  const dynamicKeys = new Map<string, string>();
  for (const key in manifest) {
    const imports: string[] | undefined = manifest[key].dynamicImports;
    if (!imports) continue;
    for (const dep of imports) {
      // A chunk that absorbed one of its own lazy targets imports itself;
      // that says nothing about whether it is an entry.
      if (dep !== key && !dynamicKeys.has(dep)) dynamicKeys.set(dep, key);
    }
  }
  for (const [key, importer] of dynamicKeys) {
    const entry = manifest[key];
    if (!entry || entry.type === 'asset') continue;
    if (isConfiguredEntry(key, entry)) continue;
    if (entry.isEntry) {
      entry.isEntry = false;
      entry.isDynamicEntry = true;
      if (warn && !knownLazyKeys?.has(key)) {
        warn(
          `[@solidjs/vite-plugin] Reclassified the entry chunk "${key}" as a dynamic entry ` +
            `because "${importer}" dynamically imports it and it does not match a configured ` +
            `build input. If "${key}" is the application entry, its chunk absorbed a module ` +
            'that is also imported dynamically elsewhere (for example a static import of ' +
            '"@solidjs/web/serialization/decode" alongside Solid\'s own lazy import of it); ' +
            'list the entry in `build.rollupOptions.input` so the plugin can recognize it.',
        );
      }
    } else if (repairDynamicEntries && !entry.isDynamicEntry) {
      entry.isDynamicEntry = true;
    }
  }
}

/**
 * The manifest key of THE client entry — the chunk whose `<script
 * type="module">` boots the page and whose static import graph carries the
 * global CSS. `isEntry` cannot answer this: every configured build input is
 * a genuine entry (#347 keeps them flagged), and plugins routinely add more
 * inputs than the application entry (filesystem-routing's `buildInputs`
 * lists every route module, and route keys sort ahead of the plugin's own
 * `virtual:` entry). So the identity comes from configuration instead: the
 * entry start mode injected itself, or — outside start mode — the single
 * configured input when there is exactly one (including Vite's default
 * `index.html`). Several inputs and no start entry: no answer (null), and
 * consumers keep their first-`isEntry` scan.
 *
 * Matched by key or `src`, the same two spellings `isConfiguredEntry` uses.
 */
function resolveClientEntryKey(
  manifest: Record<string, any>,
  startClientEntryId: string | null,
  clientBuild: any,
  root: string,
): string | null {
  let entryId: string | null = startClientEntryId;
  if (!entryId) {
    const input = configuredBuildInput(clientBuild);
    const raw =
      input == null
        ? ['index.html']
        : typeof input === 'string'
          ? [input]
          : Array.isArray(input)
            ? input
            : Object.values(input as Record<string, unknown>);
    if (raw.length !== 1 || typeof raw[0] !== 'string') return null;
    entryId = raw[0];
  }
  const { manifestKeys } = resolveConfiguredEntries(entryId, root);
  for (const key in manifest) {
    const record = manifest[key];
    if (!record || typeof record !== 'object' || !record.file) continue;
    if (manifestKeys.has(key) || (typeof record.src === 'string' && manifestKeys.has(record.src))) {
      return key;
    }
  }
  return null;
}

/**
 * Serializes the plugin's manifest module with the client entry made
 * explicit: `_entry` names its key (the generated handler reads it before
 * falling back to scanning for `isEntry`), and its record is moved to the
 * front. The ordering matters for consumers that still identify the entry
 * by the first `isEntry` record — `@solidjs/web`'s `registerEntryAssets`,
 * which links the entry graph's stylesheets and modulepreloads into
 * `<head>`, and hand-rolled server entries — so they and `_entry` agree on
 * the same chunk. Other configured inputs keep `isEntry`; they are genuine
 * entries, just not the one the document boots.
 */
function stampClientEntry(
  manifest: Record<string, any>,
  entryKey: string | null,
  base: string,
): Record<string, any> {
  const ordered: Record<string, any> = {};
  if (entryKey && manifest[entryKey]) {
    ordered[entryKey] = manifest[entryKey];
  }
  for (const key in manifest) {
    if (key !== entryKey) ordered[key] = manifest[key];
  }
  ordered._base = base;
  if (entryKey && manifest[entryKey]) ordered._entry = entryKey;
  return ordered;
}

// The bundler's default `output.sanitizeFileName`: characters outside the
// URL-safe set become `_`, except the `:` of a leading Windows drive letter.
// Rolldown ports Rollup's rule natively and exports no JS copy, so a
// sanitizer that runs the default first has to restate it. Keep in step with
// rollup/src/utils/sanitizeFileName.ts and
// rolldown/crates/rolldown_utils/src/sanitize_filename.rs.
const INVALID_FILE_NAME_CHARS = /[\u0000-\u001F"#$%&*+,:;<=>?[\]^`{|}\u007F]/g;
const WINDOWS_DRIVE_LETTER = /^[a-z]:/i;

function defaultSanitizeFileName(name: string): string {
  const driveLetter = WINDOWS_DRIVE_LETTER.exec(name)?.[0] ?? '';
  return driveLetter + name.slice(driveLetter.length).replace(INVALID_FILE_NAME_CHARS, '_');
}

/**
 * The build's `output.sanitizeFileName`: the user's sanitizer, or the default
 * when none is set, then every run of dots collapsed to one. Chunk and asset
 * names come from file names, and the default only swaps the brackets of a
 * catch-all route module: `[...404].tsx` built to `_...404_-<hash>.js`, plus a
 * CSS asset Vite names after that chunk. Hosts, CDNs and middleware whose
 * traversal guard rejects any URL containing `..` refused the lazy route's
 * chunk, and its hydration broke (#391). A run collapses to a single dot
 * instead of being dropped because the bundler splits `[name]` and
 * `[extname]` off the sanitized name: an asset whose own name has dots
 * against its extension (`logo..png`) would otherwise lose it and build to
 * `logopng-<hash>.`. Only the last path segment is touched: with
 * `preserveModules` the name carries the module's directories, and changing a
 * directory such as `my..lib` makes the bundler reject the name.
 */
function collapseDotRuns(
  sanitizeFileName: true | ((name: string) => string) | undefined,
): (name: string) => string {
  const sanitize =
    typeof sanitizeFileName === 'function' ? sanitizeFileName : defaultSanitizeFileName;
  return (name) => {
    const sanitized = sanitize(name);
    const base = Math.max(sanitized.lastIndexOf('/'), sanitized.lastIndexOf('\\')) + 1;
    return sanitized.slice(0, base) + sanitized.slice(base).replace(/\.{2,}/g, '.');
  };
}

/**
 * Build-time flag libraries use to drop server-component-only client code
 * (#396). Always defined (`"true"` or `"false"`): an absent identifier cannot
 * be eliminated. `"true"` when `serverFunctions.components` is set, including
 * `'external'`. A user-provided `define` value wins.
 */
const SERVER_COMPONENTS_DEFINE = '__SOLID_SERVER_COMPONENTS__';

export default function solidPlugin(options: Partial<Options> = {}): Plugin[] {
  if (typeof options.ssr === 'object') {
    throw new Error(
      '[@solidjs/vite-plugin] `ssr` now only accepts a boolean ("is the app server-rendered"); ' +
        'move start-mode options to `start: {}` and set `ssr: true`. Example: ' +
        '`solid({ ssr: { document: … } })` becomes `solid({ start: { document: … }, ssr: true })`.',
    );
  }
  // Recreated in configResolved: relative include/exclude patterns must
  // resolve against the Vite root, not process.cwd() — running `vite` from
  // outside the project would otherwise change what the filter matches.
  let filter = createFilter(options.include, options.exclude);
  const serverComponentsOption =
    typeof options.serverFunctions === 'object' ? options.serverFunctions.components : undefined;
  const serverComponents = !!serverComponentsOption;
  // Replaced in `config` when the user already defined the flag. Read by
  // `configEnvironment`, which runs after `config` resolves.
  let serverComponentsDefine = JSON.stringify(serverComponents);
  // The client runtime compiled server-function references import (the
  // server-functions plugin's own default unless `runtime` is set), kept only
  // when it names a package. A relative path or an alias is app source: the
  // optimizer would bundle a copy nothing loads or, for `@/x`, serve that copy
  // so edits stop showing up. A virtual id or `/src/x` doesn't resolve for
  // `include` and only warns.
  const serverFunctionsClientRuntime = options.serverFunctions
    ? typeof options.serverFunctions === 'object' && options.serverFunctions.runtime
      ? options.serverFunctions.runtime.client
      : '@solidjs/web/server-functions'
    : undefined;
  const serverFunctionsClientDep =
    serverFunctionsClientRuntime && isPackageSpecifier(serverFunctionsClientRuntime)
      ? serverFunctionsClientRuntime
      : undefined;
  // `start: true` is sugar for the empty options bag — one start mode,
  // two spellings — so normalize here and let everything downstream see a
  // single shape (`false` behaves exactly like omission).
  const startOptions: StartOptions | null =
    options.start === true ? {} : options.start || null;
  const styleFilterOptions = startOptions?.css?.filter;
  // The CSS crawl walks the module graph from the app's own entries, so a
  // plain createFilter allowlist can't express the option's purpose (opting
  // node_modules graphs in): a bare `include` would reject the app sources
  // the crawl has to traverse to ever reach the included package. Instead
  // `include` rescues files on top of the baseline (everything except
  // `exclude`, which defaults to node_modules), while a file matching both
  // patterns stays excluded — createFilter's own conflict rule.
  const createStyleFilter = (resolve?: string) => {
    const opts = resolve === undefined ? undefined : { resolve };
    const base = createFilter(
      undefined,
      styleFilterOptions?.exclude ?? DEFAULT_STYLE_EXCLUDE,
      opts,
    );
    const include = styleFilterOptions?.include;
    const hasInclude = include != null && (!Array.isArray(include) || include.length > 0);
    const included = hasInclude ? createFilter(include, styleFilterOptions?.exclude, opts) : null;
    return (id: string) => base(id) || (included ? included(id) : false);
  };
  let styleFilter = createStyleFilter();
  const filterDevStyles = (id: string) => styleFilter(id);
  // `start.external` only means something when a server side exists to hand
  // over (SSR start mode); in client mode it is a documented no-op.
  const externalDevServer = !!options.ssr && !!startOptions?.external;
  // Chrome Performance panel tracks: `null` opts out, otherwise the options
  // the injected module enables them with (dev serve only; see the
  // `solid:performance-tracks` plugin and the start-mode entry codegen).
  const performanceTracksOptions = resolvePerformanceTracksOptions(options.performanceTracks);

  let needHmr = false;
  let replaceDev = false;
  let observe = false;
  // Resolved absolute path of the start-mode document shell (normalized to
  // forward slashes, matching Vite ids), reported back by the start plugin's
  // config hook. The document is the one module whose client compile must
  // decline HMR instead of taking a refresh boundary: it hydrates the whole
  // `document`, and no component swap can re-claim `document.documentElement`
  // — an accepted update would be absorbed with nothing visibly changing
  // (solidjs/solid#3151). Declining makes a save invalidate the module, so
  // Vite falls back to a full page reload: the honest cost.
  let documentModuleId: string | null = null;
  // The live dev server, kept so the dev manifest module can bake the bridge
  // endpoint URL in when its code is generated (see devManifestBridgeUrl).
  let devServer: ViteDevServer | null = null;
  let projectRoot = process.cwd();
  let isTestMode = false;
  let serverTestPosture = false;

  // Lets the dependency scanner crawl `.tsrx` imports. Registered on every
  // environment's `optimizeDeps` (top-level for client, configEnvironment
  // for the rest).
  const tsrxDepScanPlugin = {
    name: 'solid:tsrx-dep-scan',
    async transform(source: string, id: string) {
      if (!isTsrxModule(id) || isTsrxCssModule(id)) return null;
      const compiler = await loadNativeCompiler();
      const result = await compiler.transformAsync(source, {
        ...getSolidOptions(options, false, replaceDev, observe, isTestMode),
        filename: cleanModuleId(id),
        sourceMap: false,
      });
      const stripped = await transformWithOxc(result.code, cleanModuleId(id) + '.tsx', {
        lang: 'tsx',
        sourcemap: false,
        target: 'esnext',
      });
      return { code: stripped.code, map: null };
    },
  };
  let isBuild = false;
  let isSsrBuild = false;
  let base = '/';
  let logger: Logger | null = null;
  // Set in configResolved when a worker-targeted server build would carry
  // the plugin's `@solidjs/web/storage` import; emitted once from buildStart.
  let workerTargetWarning = false;
  let clientOutDir: string | null = null;
  // The client environment's resolved build options, for the configured
  // entry input. Read off the resolved config so the SSR half of a
  // two-invocation build (`vite build --ssr`) still knows the client's
  // entries when it bakes the client manifest in.
  let clientBuildConfig: any = null;
  // The client entry start mode injects into the client build's input
  // (reported by startServe): the one input that IS the application entry,
  // as opposed to further inputs other plugins add (e.g. filesystem-routing's
  // `buildInputs`, which lists every route module). Null outside start mode.
  let startClientEntryId: string | null = null;
  let solidPkgsConfig: Awaited<ReturnType<typeof crawlFrameworkPkgs>>;
  // Names of the packages `isSemiFrameworkPkgByJson` classified, so their
  // dependencies can be taken back out of `optimizeDeps.include` (see below).
  const semiFrameworkPkgs = new Set<string>();
  const tsrxCss = new Map<string, string>();

  // The client build's manifest, read back by SSR builds. In builder-mode
  // (single process, e.g. SolidStart's nitro plugin) the client build runs
  // first and generateBundle records its actual outDir — authoritative, since
  // such setups relocate it. Two-invocation builds (`vite build --outDir
  // dist/client` then `vite build --ssr`) run in separate processes, so the
  // SSR process falls back to the `dist/client` convention.
  function clientManifestPath(): string | null {
    for (const dir of [clientOutDir, 'dist/client']) {
      if (!dir) continue;
      const manifestPath = path.resolve(projectRoot, dir, '.vite/manifest.json');
      if (existsSync(manifestPath)) return manifestPath;
    }
    return null;
  }

  // Dynamically imported project modules in the client build. Each is
  // emitted as an explicit chunk so it always gets its own manifest entry
  // keyed by source path — even when manualChunks or dual static/dynamic
  // imports would otherwise fold it facade-less into a shared chunk (which
  // would break resolveAssets lookups and hydration module preloading).
  // Driven from moduleParsed so it covers every lazy() target, including
  // import.meta.glob entries that never pass through the moduleUrl transform.
  const emittedLazyChunks = new Set<string>();
  // Keep the emitted references because a lazy module's importer may be
  // removed from the final bundle, leaving no dynamic-import edge to identify
  // its facade chunk during generateBundle.
  const emittedLazyChunkRefs: string[] = [];

  // Whether the current hook invocation belongs to a client (browser) build.
  // Builder-mode builds (e.g. SolidStart's nitro plugin) run the client and
  // ssr environments through one Vite process with shared plugins, so the
  // process-wide isSsrBuild flag from configResolved can't tell them apart —
  // the per-environment consumer can. Classic two-invocation builds
  // (`vite build` / `vite build --ssr`) fall back to the flag.
  function isClientBuild(ctx: { environment?: { config?: { consumer?: string } } }): boolean {
    const consumer = ctx.environment?.config?.consumer;
    if (consumer) return consumer === 'client';
    return !isSsrBuild;
  }

  /**
   * Replaces lazy() moduleUrl placeholders injected by the babel plugin with
   * project-relative module paths resolved through Vite's resolver.
   */
  async function resolveLazyModuleUrls(ctx: any, code: string, importer: string): Promise<string> {
    const placeholderRe = new RegExp('"' + LAZY_PLACEHOLDER_PREFIX + '([^"]+)"', 'g');
    let match;
    const resolutions: Array<{ placeholder: string; resolved: string }> = [];
    while ((match = placeholderRe.exec(code)) !== null) {
      const specifier = match[1];
      const resolved = await ctx.resolve(specifier, importer);
      if (resolved) {
        // The query is part of the module identity: Rollup keys the facade
        // chunk (and thus the Vite manifest entry) by the queried module id,
        // and in dev the queried URL can serve different plugin output than
        // the bare one — stripping it here would break both lookups.
        const queryIndex = resolved.id.indexOf('?');
        const file = queryIndex === -1 ? resolved.id : resolved.id.slice(0, queryIndex);
        const query = queryIndex === -1 ? '' : resolved.id.slice(queryIndex);
        const relativeId = path.relative(projectRoot, file).split(path.sep).join('/') + query;
        resolutions.push({
          placeholder: match[0],
          resolved: '"' + relativeId + '"',
        });
      }
    }
    for (const { placeholder, resolved } of resolutions) {
      code = code.replace(placeholder, resolved);
    }
    return code;
  }

  /**
   * SSR transforms append a `$$moduleUrl` export carrying the module's
   * client-manifest key (project-relative source path, module query
   * included — a queried module is its own identity, with its own facade
   * chunk and manifest entry). Server-side `lazy()` reads it off the
   * resolved module when the callsite has no static import specifier to
   * transform — e.g. `lazy` over an `import.meta.glob` entry — so asset
   * resolution and hydration preloading still work. Client builds are
   * untouched.
   */
  function injectSsrModuleId(code: string, id: string, isSsr: boolean): string {
    if (!isSsr || /node_modules/.test(id) || code.includes('$$moduleUrl')) return code;
    const queryIndex = id.indexOf('?');
    const file = queryIndex === -1 ? id : id.slice(0, queryIndex);
    const query = queryIndex === -1 ? '' : id.slice(queryIndex);
    const relativeId = path.relative(projectRoot, file).split(path.sep).join('/') + query;
    return code + `\nexport const $$moduleUrl = ${JSON.stringify(relativeId)};\n`;
  }

  function nativeTsrxCss(result: unknown): string {
    const css = (result as { css?: unknown }).css;
    return typeof css === 'string' ? css : '';
  }

  function babelTsrxCss(result: babel.BabelFileResult): string {
    const css = (result.metadata as { css?: unknown } | undefined)?.css;
    return typeof css === 'string' ? css : '';
  }

  async function compileTsrxCss(source: string, id: string): Promise<string> {
    const solidOptions = getSolidOptions(options, false, replaceDev, observe, isTestMode);
    if (options.compiler === 'babel') {
      const babelUserOptions = await getBabelUserOptions(options, source, id, false);
      const babelOptions = mergeAndConcat(babelUserOptions, {
        root: projectRoot,
        // Keep .tsrx: the Babel plugin uses it to select its TSRX parser.
        filename: id,
        sourceFileName: id,
        ast: false,
        code: false,
        sourceMaps: false,
        configFile: false,
        babelrc: false,
        parserOpts: {
          plugins: ['jsx', 'decorators', 'typescript'],
        },
        plugins: [[solid, solidOptions]],
      }) as babel.TransformOptions;
      const result = await babel.transformAsync(source, babelOptions);
      return result ? babelTsrxCss(result) : '';
    }

    const compiler = await loadNativeCompiler();
    const result = await compiler.transformAsync(source, {
      ...solidOptions,
      filename: id,
      sourceMap: false,
    });
    return nativeTsrxCss(result);
  }

  const mainPlugin: Plugin = {
    name: 'solid',
    enforce: 'pre',

    async config(userConfig, { command }) {
      // We inject the dev mode only if the user explicitly wants it or if we are in dev (serve) mode
      replaceDev = options.dev === true || (options.dev !== false && command === 'serve');
      observe = options.observe === true;
      projectRoot = userConfig.root || projectRoot;
      isTestMode = userConfig.mode === 'test';
      // Per-vitest-project posture: the client posture (browser conditions,
      // dom codegen, jsdom default) is right for DOM component tests but
      // wrong for server-runtime unit tests. A project that explicitly opts
      // into a server runtime — `test: { environment: 'node' }` (or
      // 'edge-runtime') — gets the server posture end to end: no browser
      // condition injection, so the framework resolves its real server
      // build (isServer true) with no inline/alias workarounds. DOM
      // environments (the jsdom default, happy-dom, browser mode) keep the
      // client posture. Each vitest project resolves its own config, so the
      // hooks below see the posture of the project they serve.
      serverTestPosture =
        isTestMode &&
        ((userConfig as any).test?.environment === 'node' ||
          (userConfig as any).test?.environment === 'edge-runtime');

      solidPkgsConfig = await crawlFrameworkPkgs({
        viteUserConfig: userConfig,
        root: projectRoot || process.cwd(),
        isBuild: command === 'build',
        isFrameworkPkgByJson(pkgJson) {
          return containsSolidField(pkgJson.exports || {});
        },
        // `false` = neither framework nor semi-framework, and don't crawl
        // its deps; `undefined` = unknown, fall through to the json checks.
        isFrameworkPkgByName(name) {
          return isNonRuntimeSolidPkg(name) ? false : undefined;
        },
        // Under `vite dev` the runtime must not be split in two. Inlined
        // modules resolve `solid-js` through Vite with `development` (its dev
        // server build); an externalized package's own imports are resolved by
        // Node, which has no `development` condition, so it loads the
        // production build instead. Both then run, each with its own
        // `sharedConfig` — the manifest `renderToStream` sets lands on one and
        // `lazy()` reads the other. `resolve.externalConditions` below only
        // fixes the external's own entry, not what it imports, so every
        // package that consumes the runtime has to go through Vite as well.
        // Semi-framework is the right class: `ssr.noExternal` without
        // `optimizeDeps.exclude`, since these hold no raw Solid components.
        isSemiFrameworkPkgByJson(pkgJson) {
          // Same gate as the core inlining in configEnvironment: dev serve or
          // an observe build (the `observe` condition selects a server build
          // the same way `development` does, and an externalized consumer
          // would split it just the same), never vitest (it manages inlining
          // via test.server.deps).
          if (!(replaceDev || observe) || isTestMode) return false;
          const semi = SOLID_RUNTIME_PKGS.some(
            (name) => pkgJson.dependencies?.[name] || pkgJson.peerDependencies?.[name],
          );
          if (semi && typeof pkgJson.name === 'string') semiFrameworkPkgs.add(pkgJson.name);
          return semi;
        },
      });

      // A semi-framework package is inlined for ONE reason: so it resolves the
      // runtime through Vite and shares the app's copy. vitefu's crawl treats
      // it like a framework package for its dependencies too — every CJS
      // dependency is deep-included (`"pkg > dep"`) so the browser optimizer
      // pre-bundles it. For a library that ships its build-time half in the
      // same package (a Vite plugin, a compiler binding, a CLI) that pushes
      // node-only modules into the client's pre-bundle: `@yak/solid` lists
      // `@swc/core`, and rolldown then fails on its native `.node` binding
      // before `vite dev` serves a page (#375). Nothing about sharing the
      // runtime needs the package's dependencies pre-bundled, so any chain
      // that runs through a semi-framework package is dropped; a browser-side
      // CJS dependency of such a package is discovered and optimized on
      // first use instead, as it was before the package was classified at
      // all. Framework packages (a `solid` export condition) keep vitefu's
      // full treatment — that is the long-standing contract for them.
      if (semiFrameworkPkgs.size > 0) {
        solidPkgsConfig.optimizeDeps.include = solidPkgsConfig.optimizeDeps.include.filter(
          (entry) => !entry.split(' > ').some((name) => semiFrameworkPkgs.has(name)),
        );
      }

      // fix for bundling dev in production
      const nestedDeps = replaceDev ? ['solid-js', '@solidjs/web'] : [];
      // `@solidjs/signals` is the reactive core `solid-js` depends on.
      // `@solidjs/diagnostics/browser` and `solid-js/attribution` import it
      // directly, so a nested/duplicated install (npm nesting a second copy
      // under a package that lists it as a dependency) yields a second
      // engine beside the one `solid-js` loads — the same two-engines
      // symptom the `optimizeDeps.include` entries below guard against on
      // the pre-bundle path. Dedupe it to the app's copy — but only when the
      // app root can reach one. `resolve.dedupe` resolves the listed package
      // from the root, and Vite's Node-side resolver (`fetchModule` for
      // externalized SSR imports, and the externalize decision itself) has
      // no importer fallback when that misses. Under pnpm's isolated layout
      // signals exists only as `solid-js`'s transitive dependency, so with
      // the entry always on, `import "@solidjs/signals"` from the inlined
      // `solid-js` fails with ERR_MODULE_NOT_FOUND as soon as anything
      // externalizes it (vitefu does, once a semi-framework package such as
      // `@solidjs/diagnostics` lists it under `dependencies`). With no root
      // copy there is nothing to dedupe TO, so the gate loses nothing. Not
      // added to `optimizeDeps.include`: the optimizer already reaches
      // signals through `solid-js`, and an include entry that doesn't
      // resolve from the root logs a warning on every start.
      const dedupe =
        replaceDev && findPackageDir('@solidjs/signals', path.resolve(projectRoot || process.cwd()))
          ? [...nestedDeps, '@solidjs/signals']
          : nestedDeps;

      const userTest = (userConfig as any).test ?? {};
      const test = {} as any;
      if (userConfig.mode === 'test') {
        // to simplify the processing of the config, we normalize the setupFiles to an array
        const userSetupFiles: string[] =
          typeof userTest.setupFiles === 'string'
            ? [userTest.setupFiles]
            : userTest.setupFiles || [];

        // Regardless of the app's `ssr` flag: tests run with the client
        // posture (DOM component tests are the norm), so the default test
        // environment is a DOM. Node-environment tests opt in explicitly.
        // Browser-mode projects get the real browser DOM, so don't default
        // them to jsdom — vitest probes for the environment's package at
        // startup and fails the run if jsdom isn't installed. They fall
        // back to vitest's own node default (no package probe).
        // A root config that defines `test.projects` (or the pre-vitest-4
        // `test.workspace`) doesn't run tests itself: each project controls
        // its own environment, so the root gets no jsdom default either —
        // otherwise vitest probes for jsdom at the root on startup even when
        // every project runs under node or in the browser. Note that an
        // inline project with `extends: true` inherits the root file's
        // `test.projects` and opts out too: projects declare their
        // environment explicitly, as in vitest's own projects guide.
        // https://github.com/solidjs/solid-vite-plugin/issues/205
        if (
          !userTest.environment &&
          !userTest.browser?.enabled &&
          !userTest.workspace &&
          !userTest.projects
        ) {
          test.environment = 'jsdom';
        }

        // Vitest 5 defaults `test.sharedViteServer` to true: inline projects
        // then reuse the root Vite server and take their `test` options from
        // the raw root block captured BEFORE any `config` hook runs, so nothing
        // injected here (posture, jest-dom, server.deps) reaches them. Vitest
        // reads the option off the resolved root config (getOwnServerReason), so
        // this restores per-project resolution as under Vitest 4 (#369).
        if (userTest.projects && userTest.sharedViteServer === undefined) {
          test.sharedViteServer = false;
        }

        if (serverTestPosture) {
          // The worker pool is shared across the whole vitest workspace and
          // imports externalized deps natively with `--conditions` derived
          // from the ROOT config — which carries the client posture's
          // 'browser'. Inline the framework so every resolution goes through
          // THIS project's (server) conditions instead: one server-build
          // instance end to end (request-event storage included).
          if (!userTest.server?.deps?.inline) {
            test.server = { deps: { inline: [/solid-js/, /@solidjs[+/]web/] } };
          }
        } else if (
          !userTest.server?.deps?.external?.find((item: string | RegExp) =>
            /solid-js/.test(item.toString()),
          )
        ) {
          test.server = { deps: { external: [/solid-js/] } };
        }
        // jest-dom's DOM matchers have no place in a server-posture project;
        // vitest browser mode already has bundled jest-dom assertions
        // https://main.vitest.dev/guide/browser/assertion-api.html#assertion-api
        if (!userTest.browser?.enabled && !serverTestPosture) {
          const jestDomImport = getJestDomExport(
            userSetupFiles,
            path.resolve(projectRoot || process.cwd()),
          );
          if (jestDomImport) {
            test.setupFiles = [jestDomImport];
          }
        }
      }

      const userDefine = userConfig.define?.[SERVER_COMPONENTS_DEFINE];
      if (typeof userDefine === 'string') serverComponentsDefine = userDefine;

      return {
        /**
         * We only need esbuild on .ts or .js files.
         * .tsx & .jsx files are handled by us
         */
        // esbuild: { include: /\.ts$/ },
        // resolve.conditions is handled per-environment in configEnvironment.
        // Build and dev source (via /@vite/env). The optimizer ignores this
        // and gets the same flag in configEnvironment.
        define: {
          [SERVER_COMPONENTS_DEFINE]: serverComponentsDefine,
        },
        resolve: {
          dedupe,
        },
        optimizeDeps: {
          extensions: ['.tsrx'],
          include: [
            ...nestedDeps,
            // Dev refresh wrappers import the solid-js/refresh runtime in
            // every mode; pre-bundle it up front so its discovery doesn't
            // trigger a re-optimize + full reload on first use.
            ...(command === 'serve' && options.hot !== false && !options.refresh?.disabled
              ? [REFRESH_RUNTIME_SOURCE]
              : []),
            // The server-components client runtime is imported by the
            // (virtual) client entry, and compiled function references
            // import the server-function client runtime; pre-bundle both up
            // front — in one optimizer pass — so a mid-session discovery
            // can't trigger a re-optimize + full reload, and both entries
            // share one instance of the transport config module (the
            // server-components runtime installs its response policy there).
            ...(command === 'serve' && serverComponents
              ? ['@solidjs/web/frames', '@solidjs/web/server-functions']
              : []),
            // Plain `serverFunctions` needs the runtime too: the scanner never
            // runs the transform that adds its import, so the first "use server"
            // module forces the same re-optimize + full reload (in Vitest
            // browser mode, "Vite unexpectedly reloaded a test").
            ...(command === 'serve' &&
            serverFunctionsClientDep &&
            !(serverComponents && serverFunctionsClientDep === '@solidjs/web/server-functions')
              ? [serverFunctionsClientDep]
              : []),
            // The attribution engine and the Chrome performance-tracks
            // recorder are subpaths the scanner only sees when the app's own
            // graph imports them; a consumer it never crawls (a linked
            // package, a `solid`-condition package vitefu excluded from the
            // scan) importing one mid-session would discover it late →
            // re-optimize → a second `@solidjs/signals` core beside the one
            // `solid-js` was bundled with. Pre-bundle both in the first pass
            // so they share that core. Both subpaths exist for every version
            // in the peer range (^2.0.0-rc.10: `solid-js/attribution` since
            // rc.8, `@solidjs/web/performance-tracks` since rc.10).
            ...(command === 'serve'
              ? ['solid-js/attribution', '@solidjs/web/performance-tracks']
              : []),
            ...solidPkgsConfig.optimizeDeps.include,
          ],
          exclude: solidPkgsConfig.optimizeDeps.exclude,
          // Keep Solid TSX from injecting React's automatic runtime during scanning.
          rolldownOptions: {
            transform: { jsx: { runtime: 'classic' as const } },
            plugins: [tsrxDepScanPlugin],
          },
        },
        ...(Object.keys(test).length ? { test } : {}),
      };
    },

    configEnvironment(name, config, opts) {
      // The optimizer does not apply the top-level `define`, and Vite only
      // seeds the `client` environment from the top-level `optimizeDeps`.
      // Every environment's pre-bundle therefore gets the flag here, unless
      // that environment already set its own value. #396
      const optimizeDeps = (config.optimizeDeps ??= {});
      const rolldownOptions = (optimizeDeps.rolldownOptions ??= {});
      const transform = (rolldownOptions.transform ??= {});
      const define = (transform.define ??= {});
      define[SERVER_COMPONENTS_DEFINE] ??= serverComponentsDefine;

      config.resolve ??= {};
      // Emulate Vite default fallback for `resolve.conditions` if not set
      if (config.resolve.conditions == null) {
        if (config.consumer === 'client' || name === 'client' || opts.isSsrTargetWebworker) {
          config.resolve.conditions = [...defaultClientConditions];
        } else {
          config.resolve.conditions = [...defaultServerConditions];
        }
      }
      config.resolve.conditions = [
        'solid',
        ...(replaceDev ? ['development'] : []),
        // `development` nests above `observe` in the runtime's exports, so
        // both may be present: dev serve keeps the dev build, builds get the
        // observe build.
        ...(observe ? ['observe'] : []),
        // Tests resolve the browser builds even when the app is
        // server-rendered — the client posture applies to the whole test
        // pipeline, not just the codegen. Projects that explicitly opt into
        // a server runtime (`test.environment: 'node'` / 'edge-runtime')
        // keep the default server conditions instead, so the framework's
        // real server build resolves (isServer true).
        ...(isTestMode && !serverTestPosture && !opts.isSsrTargetWebworker ? ['browser'] : []),
        ...config.resolve.conditions,
      ];

      // Vite seeds only the `client` environment from the top-level
      // `optimizeDeps` set in `config`, so every other environment would
      // scan Solid TSX with Rolldown's default (React's automatic runtime)
      // and fail on an unresolvable `react/jsx-dev-runtime`. Server
      // environments default to `noDiscovery: true`, but hosts that run SSR
      // outside Node turn discovery back on (@cloudflare/vite-plugin), #387.
      if (name !== 'client') {
        const optimizeDeps = (config.optimizeDeps ??= {});
        if (!optimizeDeps.extensions?.includes('.tsrx')) {
          optimizeDeps.extensions = [...(optimizeDeps.extensions ?? []), '.tsrx'];
        }
        const rolldownOptions = (optimizeDeps.rolldownOptions ??= {});
        const transform = (rolldownOptions.transform ??= {});
        transform.jsx ??= { runtime: 'classic' };
        rolldownOptions.plugins = rolldownOptions.plugins
          ? [rolldownOptions.plugins, tsrxDepScanPlugin]
          : [tsrxDepScanPlugin];
      }

      // `resolve.conditions` above only governs modules Vite inlines.
      // Externalized server deps are resolved by `fetchModule` with
      // `resolve.externalConditions` (default `['node', 'module-sync']`) and
      // handed to the module runner as concrete file paths — without
      // `development` there, packages that select their dev build through
      // the `development` export condition (@solidjs/web's server-functions
      // runtime among them) run their PRODUCTION copy under `vite dev`:
      // server errors reach the client sanitized to "Internal Server Error"
      // instead of carrying the real message, dev-only diagnostics vanish.
      // So the dev flag has to reach both lists — and `observe` selects its
      // server build the same way, with the same split if it only reaches
      // one list.
      if ((replaceDev || observe) && config.consumer !== 'client' && name !== 'client') {
        config.resolve.externalConditions = [
          ...(replaceDev ? ['development'] : []),
          ...(observe ? ['observe'] : []),
          ...(config.resolve.externalConditions ?? defaultExternalConditions),
        ];

        // `externalConditions` only reaches the imports the module runner
        // resolves itself. An externalized package's OWN imports are resolved
        // by Node, with Node's conditions — never `development`. Since
        // solid 2.0.0-rc.7 both `solid-js` and `@solidjs/web` ship a
        // `dist/server.dev.*` behind that condition, so leaving them external
        // splits the framework in two under `vite dev`: the app's `solid-js`
        // is the runner's dev copy while `@solidjs/web`'s `import "solid-js"`
        // lands on Node's prod copy. `renderToStream` then installs the asset
        // resolver on one `sharedConfig` and `lazy()` reads the other ("no
        // asset manifest is set"), with every other module-level singleton
        // (owner tracking, request events, hydration keys) split the same
        // way. Inlining the two core packages makes every resolution — theirs
        // included — go through the environment's conditions, so one dev
        // build is loaded end to end. Framework packages that declare the
        // `solid` export condition are already inlined via vitefu below and
        // reach the same copy. Vitest projects manage their own inlining
        // (`test.server.deps` above) and are left alone, as is a host that
        // set `noExternal: true` (everything is inlined already).
        //
        // `seroval` and `seroval-plugins` split the same way: both ship a
        // `dist/dev` build behind `development`, and `@solidjs/web` imports
        // both. Left external, `seroval-plugins` loads through Node and its
        // own `import "seroval"` lands on the prod copy, while the inlined
        // `@solidjs/web` gets the runner's dev copy. Seroval tells a stream
        // apart with `instanceof Stream`, so the `Stream` that
        // `ReadableStreamPlugin` builds from one copy is rejected by the
        // other's serializer ("cannot be parsed/serialized"). A server
        // component that lands after the shell flushes hits this: its
        // `sc:live` channel is a ReadableStream serialized into the document.
        if (!isTestMode && config.resolve.noExternal !== true) {
          const noExternal = config.resolve.noExternal;
          config.resolve.noExternal = [
            ...(Array.isArray(noExternal) ? noExternal : noExternal ? [noExternal] : []),
            'solid-js',
            '@solidjs/web',
            'seroval',
            'seroval-plugins',
          ];
        }
      }

      // Set resolve.noExternal and resolve.external for the SSR environment.
      // Only set resolve.external if noExternal is not true (to avoid conflicts with plugins like Cloudflare)
      if (name === 'ssr' && solidPkgsConfig) {
        if (config.resolve.noExternal !== true) {
          const hostNoExternal = config.resolve.noExternal;
          const noExternal = [
            ...(Array.isArray(hostNoExternal)
              ? hostNoExternal
              : hostNoExternal
                ? [hostNoExternal]
                : []),
            ...solidPkgsConfig.ssr.noExternal,
          ];
          config.resolve.noExternal = noExternal;
          // vitefu externalizes the non-framework deps of every framework
          // package in dev, and Vite gives `external` precedence over
          // `noExternal`. A framework package that lists solid-js or
          // @solidjs/web under `dependencies` (not peer — e.g.
          // @tanstack/solid-router 2.0.0-rc.7 → @solidjs/web) would therefore
          // re-externalize a core inlined above and split the runtime again.
          // Nothing inlined may appear in `external`.
          //
          // "Inlined" means whatever `noExternal` claims, judged the way Vite
          // judges it (`createFilter(undefined, noExternal, { resolve:
          // false })` in its `createIsConfiguredAsExternal`): string entries
          // are picomatch patterns, RegExp entries test the id. A literal
          // `includes` check only caught exact names, so a host that inlines
          // its packages by pattern — TanStack Start's `@tanstack/start**`,
          // whose start-server-core resolves `#tanstack-*` imports only when
          // Vite processes it — saw them re-externalized once the
          // semi-framework crawl reached them through its Solid adapter
          // (their non-Solid dependencies land in vitefu's `ssr.external`),
          // and `vite dev` failed with ERR_PACKAGE_IMPORT_NOT_DEFINED.
          const keepsExternal =
            noExternal.length > 0
              ? createFilter(undefined, noExternal, { resolve: false })
              : () => true;
          config.resolve.external = [
            ...(Array.isArray(config.resolve.external) ? config.resolve.external : []),
            ...solidPkgsConfig.ssr.external.filter((dep) => keepsExternal(dep)),
          ];
        }
      }
    },

    configResolved(config) {
      isBuild = config.command === 'build';
      isSsrBuild = !!config.build.ssr;
      base = config.base;
      projectRoot = config.root;
      clientBuildConfig = (config as any).environments?.client?.build ?? config.build;
      filter = createFilter(options.include, options.exclude, { resolve: projectRoot });
      styleFilter = createStyleFilter(projectRoot);
      // `components: 'external'` is the acknowledgement that a composing
      // host (e.g. the Astro adapter or TanStack Start's Solid integration)
      // owns the document wiring itself — behavior is identical to `true`,
      // only this warning is skipped. Under SSR start mode it's redundant
      // but harmless (treated exactly as `true`).
      if (
        serverComponents &&
        serverComponentsOption !== 'external' &&
        !(options.start && options.ssr)
      ) {
        config.logger.warn(
          '[@solidjs/vite-plugin] serverFunctions.components is set without SSR start mode (the `start` ' +
            'option with `ssr: true`), so the plugin only installs the endpoint response transform ' +
            '(server functions returning components stream correctly). The document wiring — the ' +
            'render plugin (with the direct-call transform) and the client-side ' +
            "installServerComponents() call — is emitted by SSR start mode's generated entries; " +
            'without it, server components only mount from post-boot streams and your client code ' +
            'must call installServerComponents() itself. If a composing host owns that wiring, set ' +
            "`components: 'external'` to acknowledge it and silence this warning.",
        );
      }
      // The generated server code — the start-mode handler and the
      // server-function handler module — imports `@solidjs/web/storage`,
      // the one Solid module that needs `node:async_hooks`
      // (AsyncLocalStorage keeps the request event live across `await`s;
      // there is no sync-scope fallback, solidjs/solid#3597). A worker-
      // targeted server build (`ssr.target: 'webworker'`, e.g. Shopify
      // Oxygen's Vite plugin) only fails at deploy with a bare
      // module-not-found, so name the requirement and the fix at build
      // time instead. Detected here, emitted from the ssr environment's
      // buildStart so it lands once per server build: the default builder
      // resolves the config once per environment on top of its own pass,
      // so a configResolved warning would print three times per build.
      // Build-only — dev runs the ssr environment in Node.
      workerTargetWarning =
        isBuild &&
        !!(startOptions || options.serverFunctions) &&
        config.ssr?.target === 'webworker';
      logger = config.logger;
      needHmr =
        config.command === 'serve' &&
        config.mode !== 'production' &&
        options.hot !== false &&
        !options.refresh?.disabled;
    },

    configureServer(server) {
      devServer = server;
      // Dev asset resolution for SSR: the virtual manifest module (evaluated
      // in the SSR environment) picks this resolver up through the global
      // registry keyed by project root — or, from isolated module runners
      // that don't share globals with this process, through the HTTP bridge
      // endpoint the middleware serves.
      if (options.ssr || options.start) {
        registerDevAssetResolver(
          server.config.root,
          createDevAssetResolver(server, filterDevStyles),
        );
        installDevManifestBridge(server);
      }
      if (!needHmr) return;
      // When a module has a syntax error, Vite sends the error overlay via
      // WebSocket but the failed import triggers invalidation in solid-refresh.
      // This propagates up to @refresh reload boundaries (e.g. document-level
      // App components in SSR), causing a full-reload that overrides the overlay.
      // We suppress update/full-reload messages that immediately follow an error.
      const hot = server.hot ?? (server as any).ws;
      if (!hot) return;
      let lastErrorTime = 0;
      const origSend = hot.send.bind(hot);
      hot.send = function (this: any, ...args: any[]) {
        const payload = args[0];
        if (typeof payload === 'object' && payload) {
          if (payload.type === 'error') {
            lastErrorTime = Date.now();
          } else if (
            lastErrorTime &&
            (payload.type === 'full-reload' || payload.type === 'update')
          ) {
            if (Date.now() - lastErrorTime < 200) return;
            lastErrorTime = 0;
          }
        }
        return origSend(...args);
      } as typeof hot.send;
    },

    buildStart() {
      // `ssr.target` is a property of the `ssr` environment specifically
      // (Vite reads it as `environment.name === 'ssr'` too), and that is the
      // one environment whose bundle carries the storage import. Each
      // environment gets its own plugin instance under the default builder,
      // so this runs exactly once for the server build — and not at all for
      // the client build or a `vite build --ssr`-less client-only build.
      if (!workerTargetWarning || this.environment?.name !== 'ssr') return;
      logger!.warn(
        '[@solidjs/vite-plugin] The server build targets a worker runtime (ssr.target = "webworker"). ' +
          "Solid's server runtime requires Node's async context (node:async_hooks / AsyncLocalStorage). " +
          'On Cloudflare Workers and compatible runtimes (e.g. Shopify Oxygen) set a compatibility_date ' +
          'of 2026-08-04 or later (nodejs_compat is on by default from that date), or enable the ' +
          'nodejs_compat flag. See https://github.com/solidjs/solid/issues/3597',
      );
    },

    async hotUpdate({ file, modules, read }) {
      if (isTsrxModule(file) && this.environment.name === 'client') {
        updateTsrxCss(tsrxCss, file, await compileTsrxCss(await read(), file));
        const cssModule = this.environment.moduleGraph.getModuleById(resolvedTsrxCssModuleId(file));
        if (cssModule) {
          this.environment.moduleGraph.invalidateModule(cssModule);
          if (!modules.includes(cssModule)) modules = [...modules, cssModule];
          return modules;
        }
      }

      // solid-refresh only injects HMR boundaries into client modules, so
      // non-client environments have no accept handlers. Without this, Vite
      // would see no boundaries and send full-reload messages that race with
      // client-side HMR updates. Provider-owned (non-runnable) environments
      // fall through instead: their plugin needs the real module list to
      // invalidate its remote runner, and its channel never reaches the
      // browser websocket.
      if (this.environment.name !== 'client' && isRunnableEnvironment(this.environment)) {
        // Returning [] also suppresses the signal environment-runner based
        // servers (e.g. nitro's dev worker) rely on to re-evaluate modules,
        // leaving SSR stale until a manual restart. Send the reload on this
        // environment's own channel — for runner-based environments that is
        // the runner, for the default ssr environment a no-op, and never the
        // browser websocket, so client HMR stays free of full-reload races.
        if (modules.length > 0) {
          this.environment.hot.send({ type: 'full-reload' });
          // Server-only modules are the exception to the suppression: a file
          // with no modules in the client graph has no browser HMR path at
          // all — nothing client-side accepts it, so staying silent leaves
          // the browser rendering stale server output until a manual refresh
          // (e.g. the document shell, which only the server ever imports;
          // solidjs/solid#3151). Reload the page: the honest cost, and there
          // is no client update to race with by construction.
          const clientEnv = devServer?.environments.client;
          if (clientEnv && !clientEnv.moduleGraph.getModulesByFile(file)?.size) {
            clientEnv.hot.send({ type: 'full-reload' });
          }
        }
        return [];
      }
    },

    resolveId(id) {
      const tsrxCssId = resolveTsrxCssModule(id);
      if (tsrxCssId) return tsrxCssId;
      if (id === VIRTUAL_MANIFEST_ID) return RESOLVED_VIRTUAL_MANIFEST_ID;
    },

    moduleParsed(info) {
      // SSR-mode client builds only: give every dynamically imported project
      // module its own facade chunk (exports-only preserves `default`
      // re-exports) so it keeps a manifest entry keyed by its source path
      // even when chunk grouping would otherwise absorb it. Plain SPA builds
      // have no manifest lookups to protect.
      if (!isBuild || !options.ssr || !isClientBuild(this)) return;
      for (const depId of info.dynamicallyImportedIds || []) {
        const cleanId = depId.split('?')[0];
        if (/node_modules/.test(cleanId) || cleanId.startsWith('\0')) continue;
        if (!(/\.[mc]?[tj]sx?$/i.test(cleanId) || isTsrxModule(cleanId))) continue;
        if (emittedLazyChunks.has(depId)) continue;
        emittedLazyChunks.add(depId);
        emittedLazyChunkRefs.push(
          this.emitFile({ type: 'chunk', id: depId, preserveSignature: 'exports-only' }),
        );
      }
    },

    load(id) {
      const tsrxSource = tsrxCssSourceId(id);
      if (tsrxSource) return tsrxCss.get(tsrxSource) ?? '';
      if (id === RESOLVED_VIRTUAL_MANIFEST_ID) {
        if (!isBuild) {
          return devManifestCode(
            projectRoot,
            base,
            devServer ? devManifestBridgeUrl(devServer) : null,
          );
        }
        const manifestPath = clientManifestPath();
        if (manifestPath) {
          const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8'));
          // Manifest records are keyed the way Vite keys entry chunks (the
          // root-relative facade path, also carried as `src`), so the
          // configured client inputs identify the genuine entries here too —
          // independent of `isEntry`, which the serialized manifest may have
          // lost already (older plugin builds stripped it; see #342).
          const entries = resolveConfiguredEntries(
            configuredBuildInput(clientBuildConfig),
            projectRoot,
          );
          const isConfiguredEntry = (key: string, record: any) =>
            entries.manifestKeys.has(key) ||
            (typeof record.src === 'string' && entries.manifestKeys.has(record.src));
          for (const key in manifest) {
            if (isConfiguredEntry(key, manifest[key]) && manifest[key].file) {
              manifest[key].isEntry = true;
            }
          }
          normalizeEmittedLazyEntries(manifest, {
            isConfiguredEntry,
            warn: (message) => this.warn(message),
            repairDynamicEntries: true,
          });
          const stamped = stampClientEntry(
            manifest,
            resolveClientEntryKey(manifest, startClientEntryId, clientBuildConfig, projectRoot),
            base,
          );
          // The runtime looks records up as `manifest[moduleUrl]`, so a
          // hand-written slash-prefixed key (`/src/Page.tsx`, #390) needs
          // its own property. The aliases are non-enumerable: `for…in`,
          // `Object.keys` and JSON consumers see the manifest unchanged.
          return `const manifest = ${JSON.stringify(stamped)};
for (const key of Object.keys(manifest)) {
  if (key[0] !== "/" && typeof manifest[key] === "object") {
    Object.defineProperty(manifest, "/" + key, { value: manifest[key] });
  }
}
export default manifest;`;
        }
        // SSR build before the client build produced a manifest: bake in the
        // dev-shaped fallback (registry miss degrades to js-only resolution).
        return devManifestCode(projectRoot, base, null);
      }
    },

    outputOptions: {
      // Post order: this runs after every pre and normal `outputOptions`
      // hook (and after post hooks earlier in the plugin array), so it wraps
      // the sanitizer from the config or from those hooks instead of being
      // replaced by a later one. A post hook further down can still override.
      order: 'post',
      handler(outputOptions) {
        // Every build environment, not just the client: client file names
        // become URLs (see collapseDotRuns), and the server bundle writes the
        // URLs of the assets it imports, computed with its own sanitizer.
        // Collapsing on one side only would point server-rendered `src` and
        // `href` attributes at files the client build never wrote.
        // `sanitizeFileName: false` is left as is: it is the one spelling
        // that asks for raw names, and wrapping it too would leave no way
        // out.
        if (!isBuild || outputOptions.sanitizeFileName === false) return null;
        return {
          ...outputOptions,
          sanitizeFileName: collapseDotRuns(outputOptions.sanitizeFileName),
        };
      },
    },

    generateBundle(outputOptions, bundle) {
      if (!isBuild || !isClientBuild(this)) return;
      clientOutDir = outputOptions.dir ?? null;
      // Reclassify emitted lazy facade chunks in the raw bundle (not just the
      // serialized manifest read back later) so downstream plugins inspecting
      // the bundle don't mistake them for application entries. Must precede
      // the client asset map build, which keys off dynamic entries.
      if (options.ssr) {
        // The genuine entries are the configured inputs of this very
        // environment — the plugin injects the client entry itself in start
        // mode, and Vite's default is index.html — so their facade chunks
        // are recognizable regardless of what dynamically imports them.
        const entries = resolveConfiguredEntries(
          configuredBuildInput(this.environment?.config?.build ?? clientBuildConfig),
          projectRoot,
        );
        const knownLazyKeys = new Set<string>();
        for (const ref of emittedLazyChunkRefs) {
          let fileName: string;
          try {
            fileName = this.getFileName(ref);
          } catch {
            // Ignore references retained from a previous watch build.
            continue;
          }
          const chunk = bundle[fileName];
          if (!chunk || chunk.type !== 'chunk') continue;
          // An entry that is also lazily imported stays an entry.
          if (entries.isEntryModule(chunk.facadeModuleId)) continue;
          knownLazyKeys.add(fileName);
          chunk.isEntry = false;
          chunk.isDynamicEntry = true;
        }
        normalizeEmittedLazyEntries(bundle, {
          isConfiguredEntry: (_key, chunk) => entries.isEntryModule(chunk.facadeModuleId),
          knownLazyKeys,
          warn: (message) => this.warn(message),
        });
      }
    },

    async transform(source, id, transformOptions) {
      if (isTsrxCssModule(id)) return null;
      const isSsr = getEnvironmentConsumer(this.environment, transformOptions) === 'server';
      const currentFileExtension = getExtension(id);

      const extensionsToWatch = options.extensions || [];
      const allExtensions = extensionsToWatch.map((extension) =>
        // An extension can be a string or a tuple [extension, options]
        typeof extension === 'string' ? extension : extension[0],
      );

      if (!filter(id)) {
        return null;
      }

      // The queried id is the module's real identity (facade chunk /
      // manifest key / dev URL); keep it for the `$$moduleUrl` injection
      // while the transform pipeline below works on the clean file path.
      const moduleId = id;
      id = id.replace(/\?.*$/, '');
      const isTsrx = isTsrxModule(id);
      const inNodeModules = /node_modules/.test(id);
      // Primitive names stop at node_modules: a dependency's internals
      // (Solid's own flow controls included) name what they mean to name,
      // and a composed primitive from a library is identified by its
      // package, not re-labelled by this app's build.
      const namePrimitives =
        !inNodeModules && getSourceNames(options, replaceDev, observe).primitives;

      if (!(/\.[mc]?[tj]sx$/i.test(id) || isTsrx || allExtensions.includes(currentFileExtension))) {
        // Not a JSX module. The one pass that still applies is primitive
        // naming — `createSignal` lives in `.ts`/`.js` as much as in
        // components — and it runs alone: no lazy/refresh/JSX work.
        if (namePrimitives && PRIMITIVES_ONLY_MODULE.test(id) && !DECLARATION_MODULE.test(id)) {
          const compiler = await loadNativeCompiler();
          const named = await transformPrimitiveNames(this, compiler, source, id);
          if (named === null) return null;
          return { code: named.code, map: normalizeSourceMap(named.map) };
        }
        return null;
      }

      const solidOptions = getSolidOptions(options, !!isSsr, replaceDev, observe, isTestMode);

      // We need to know if the current file extension has a typescript options tied to it
      const shouldBeProcessedWithTypescript =
        /\.[mc]?tsx$/i.test(id) ||
        isTsrx ||
        extensionsToWatch.some((extension) => {
          if (typeof extension === 'string') {
            return extension.includes('tsx');
          }

          const [extensionName, extensionOptions] = extension;
          if (extensionName !== currentFileExtension) return false;

          return extensionOptions.typescript;
        });
      const plugins: NonNullable<NonNullable<babel.TransformOptions['parserOpts']>['plugins']> = [
        'jsx',
        'decorators',
      ];

      if (shouldBeProcessedWithTypescript) {
        plugins.push('typescript');
      }

      // See the documentModuleId declaration: the document shell declines HMR
      // (no refresh boundary, explicit self-invalidation) so edits full-reload.
      const isDocumentShell = documentModuleId !== null && id === documentModuleId;
      const needRefresh = needHmr && !isSsr && !inNodeModules && !isDocumentShell;
      const declineHmr = isDocumentShell && needHmr && !isSsr;

      const babelUserOptions = await getBabelUserOptions(options, source, id, !!isSsr);

      // The native compiler picks its parser dialect from the file
      // extension; custom extensions registered through `options.extensions`
      // are unknown to it, so borrow a standard one matching the configured
      // TypeScript-ness.
      const nativeFilename =
        isTsrx || /\.(?:[mc]?[jt]s|[jt]sx)$/i.test(id)
          ? id
          : id + (shouldBeProcessedWithTypescript ? '.tsx' : '.jsx');

      // Shared native prelude for every mode: (dev/observe) the primitive
      // naming pass, the lazy() module-URL pass, then (dev/client/
      // non-node_modules) the solid-refresh HMR pass, all operating on
      // pre-JSX source. Only the JSX transform itself differs between
      // compiler backends. Sourcemaps are collected in application order and
      // merged at the end.
      const compiler = await loadNativeCompiler();
      let code = source;
      const maps: ChainableMap[] = [];

      // Authored TSRX cannot be parsed by a standalone pass; its primitives
      // are named after Solid lowering, on the generated module, below.
      if (namePrimitives && !isTsrx) {
        const named = await transformPrimitiveNames(this, compiler, code, nativeFilename);
        if (named !== null) {
          code = named.code;
          maps.push(named.map);
        }
      }

      if (isTsrx) {
        // Solid lowering preserves authored TypeScript annotations; secondary
        // passes therefore parse the generated module as TSX even though no
        // template syntax remains.
        const generatedFilename = id + '.tsx';
        const babelBaseOptions: babel.TransformOptions = {
          root: projectRoot,
          filename: id,
          sourceFileName: id,
          ast: false,
          sourceMaps: true,
          configFile: false,
          babelrc: false,
          parserOpts: {
            plugins,
          },
        };
        let css = '';

        if (options.compiler !== 'babel') {
          const result = await compiler.transformAsync(code, {
            ...solidOptions,
            filename: id,
            sourceMap: true,
          });
          code = result.code || '';
          css = nativeTsrxCss(result);
          maps.push(result.map);

          if (options.babel) {
            // The support pass cannot parse authored TSRX. On this route it
            // intentionally sees the lowered ordinary JavaScript instead.
            const supportOptions = mergeAndConcat(
              babelUserOptions,
              babelBaseOptions,
            ) as babel.TransformOptions;
            // This pass sees native-lowered ordinary JavaScript, so do not
            // route it back through Babel's TSRX parser.
            supportOptions.filename = generatedFilename;
            const supportResult = await babel.transformAsync(code, supportOptions);
            if (!supportResult) return undefined;
            code = supportResult.code || '';
            maps.push(supportResult.map);
          }
        } else {
          const babelOptions = mergeAndConcat(babelUserOptions, {
            ...babelBaseOptions,
            plugins: [[solid, solidOptions]],
          }) as babel.TransformOptions;
          const result = await babel.transformAsync(code, babelOptions);
          if (!result) return undefined;
          code = result.code || '';
          css = babelTsrxCss(result);
          maps.push(result.map);
        }

        if (namePrimitives) {
          const named = await transformPrimitiveNames(this, compiler, code, generatedFilename);
          if (named !== null) {
            code = named.code;
            maps.push(named.map);
          }
        }

        const lazyResult = await compiler.transformLazyAsync(code, {
          filename: generatedFilename,
          sourceMap: true,
        });
        code = lazyResult.code;
        maps.push(lazyResult.map);

        if (needRefresh) {
          const refreshResult = await compiler.transformRefreshAsync(code, {
            filename: generatedFilename,
            bundler: 'vite',
            fixRender: true,
            ...(typeof options.refresh?.granular === 'boolean'
              ? { granular: options.refresh.granular }
              : {}),
            jsx: false,
            importSource: REFRESH_RUNTIME_SOURCE,
            sourceMap: true,
          });
          code = refreshResult.code;
          maps.push(refreshResult.map);
        }

        code = injectSsrModuleId(await resolveLazyModuleUrls(this, code, id), moduleId, !!isSsr);
        let map = options.compiler === 'babel' ? combineSourcemaps(maps) : null;
        updateTsrxCss(tsrxCss, id, css);
        if (css) {
          code = prependTsrxCssImport(code, id);
          map = offsetSourceMapLine(map);
        }
        // Vite selects its TypeScript stripping by file extension. Since the
        // real module identity remains `.tsrx`, strip the annotations here
        // after Solid lowering instead of handing typed JavaScript to Rollup.
        const stripped = await transformWithOxc(
          code,
          generatedFilename,
          {
            lang: 'tsx',
            sourcemap: map != null,
            target: 'esnext',
          },
          map ?? undefined,
        );
        return {
          code: stripped.code,
          map: map == null ? null : stripped.map,
        };
      }

      const lazyResult = await compiler.transformLazyAsync(code, {
        filename: nativeFilename,
        sourceMap: true,
      });
      code = lazyResult.code;
      maps.push(lazyResult.map);

      if (needRefresh) {
        const refreshResult = await compiler.transformRefreshAsync(code, {
          filename: nativeFilename,
          bundler: 'vite',
          fixRender: true,
          // The napi validator rejects explicit undefined; omit to get the
          // pass's default (true).
          ...(typeof options.refresh?.granular === 'boolean'
            ? { granular: options.refresh.granular }
            : {}),
          jsx: false,
          importSource: REFRESH_RUNTIME_SOURCE,
          sourceMap: true,
        });
        code = refreshResult.code;
        maps.push(refreshResult.map);
      }

      const babelBaseOptions: babel.TransformOptions = {
        root: projectRoot,
        filename: id,
        sourceFileName: id,
        ast: false,
        sourceMaps: true,
        configFile: false,
        babelrc: false,
        parserOpts: {
          plugins,
        },
      };

      if (options.compiler !== 'babel') {
        if (options.babel) {
          // Custom babel options reintroduce a Babel support pass hosting
          // only the user's plugins, ahead of the native JSX transform.
          const supportOptions = mergeAndConcat(
            babelUserOptions,
            babelBaseOptions,
          ) as babel.TransformOptions;
          const supportResult = await babel.transformAsync(code, supportOptions);
          if (!supportResult) {
            return undefined;
          }
          code = supportResult.code || '';
          maps.push(supportResult.map);
        }

        const result = await compiler.transformAsync(code, {
          ...solidOptions,
          filename: nativeFilename,
          sourceMap: true,
        });
        maps.push(result.map);

        const finalCode = injectSsrModuleId(
          await resolveLazyModuleUrls(this, result.code || '', id),
          moduleId,
          !!isSsr,
        );

        return {
          code: declineHmr ? finalCode + DOCUMENT_HMR_DECLINE : finalCode,
          map: combineSourcemaps(maps),
        };
      }

      // Babel JSX backend: one babel.transformAsync hosting the user's
      // options plus @solidjs/babel-plugin. Appended to `plugins` (was the
      // sole preset pre-rename): user plugins still run before it, user
      // presets still run after — babel runs plugins before presets and
      // presets in reverse order, so the pass order is unchanged.
      const babelOptions = mergeAndConcat(babelUserOptions, {
        ...babelBaseOptions,
        plugins: [[solid, solidOptions]],
      }) as babel.TransformOptions;

      const result = await babel.transformAsync(code, babelOptions);
      if (!result) {
        return undefined;
      }
      maps.push(result.map);

      const finalCode = injectSsrModuleId(
        await resolveLazyModuleUrls(this, result.code || '', id),
        moduleId,
        !!isSsr,
      );

      return {
        code: declineHmr ? finalCode + DOCUMENT_HMR_DECLINE : finalCode,
        map: combineSourcemaps(maps),
      };
    },
  };

  // Ordinary modules need the directive transform before JSX. Authored TSRX
  // cannot be parsed by that standalone pass, so its companion compiler runs
  // after mainPlugin has lowered the file to ordinary JavaScript while keeping
  // the original .tsrx id for stable server-function hashes.
  const serverFunctionPlugins = options.serverFunctions
    ? serverFunctions(options.serverFunctions === true ? {} : options.serverFunctions, {
        devMiddleware: true,
        externalDevServer,
        tsrxAfterSolid: true,
        tsrxSourceMap: options.compiler === 'babel',
        // With start mode on (either variant), the dev middleware dispatches
        // the endpoint through the SSR handler so user middleware and the
        // stub-backed request event front it exactly like page SSR.
        ...(startOptions ? { ssrHandler: SSR_HANDLER_ID } : {}),
      })
    : [];
  const tsrxServerFunctionPlugin = serverFunctionPlugins.find(
    (plugin) => plugin.name === 'solid:server-functions/tsrx-compiler',
  );
  const plugins: Plugin[] = [
    boundaryModules(),
    ...serverFunctionPlugins.filter((plugin) => plugin !== tsrxServerFunctionPlugin),
    mainPlugin,
    ...(tsrxServerFunctionPlugin ? [tsrxServerFunctionPlugin] : []),
  ];

  // The `start` option opts into start-mode serving on top of the transforms;
  // the `ssr` boolean picks the mode (a bare `ssr: true` keeps the
  // historical transform-only behavior).
  if (startOptions) {
    plugins.push(
      // Typed env (`start.env`) rides both start modes: config-time
      // validation, the virtual:env/{server,client} modules, generated
      // types, and the client-bundle leak scan.
      ...startEnv(startOptions.env),
      ...startServe(startOptions, {
        serverFunctions: !!options.serverFunctions,
        // The mount the runtime is configured with (before `base`; the
        // start plugin applies it): the preview middleware passes every
        // response under it through uncompressed.
        ...(options.serverFunctions
          ? {
              serverFunctionsEndpoint: normalizeServerFunctionsEndpoint(
                options.serverFunctions === true ? undefined : options.serverFunctions.endpoint,
              ),
            }
          : {}),
        serverComponents,
        ssr: !!options.ssr,
        styleFilter: filterDevStyles,
        diagnostics: options.diagnostics ?? 'auto',
        performanceTracks: performanceTracksOptions !== null,
        onDocumentResolved(documentPath) {
          // Normalize to forward slashes to match Vite's transform ids.
          documentModuleId = documentPath ? documentPath.split(path.sep).join('/') : null;
        },
        onClientEntryResolved(entryId) {
          startClientEntryId = entryId;
        },
      }),
    );
  }

  // Agent diagnostics endpoint + injected bridge (dev serve only — the
  // plugin no-ops itself for builds and preview via `apply`, and in the
  // default auto mode additionally disables itself unless the app has
  // `@solidjs/diagnostics` installed).
  if (options.diagnostics !== false) {
    plugins.push(solidDiagnostics(options.diagnostics === true ? true : 'auto'));
  }

  // Chrome Performance panel tracks, on by default (dev serve only — the
  // plugin no-ops itself for builds and preview via `apply`). Start mode
  // imports the module from the client entry (`performanceTracks` above);
  // plain apps get it from this plugin's `transformIndexHtml`.
  if (performanceTracksOptions !== null) {
    plugins.push(solidPerformanceTracks(performanceTracksOptions));
  }

  // Builder-mode (environments API) client-before-server build ordering.
  // Server builds read the client manifest — `virtual:solid-manifest` bakes
  // dist/client/.vite/manifest.json in, and the persisted server-function
  // manifest merges the client build's discoveries — so the client
  // environment must build first. Start mode's own orchestration already
  // orders it that way (environment definition order), but a composed setup
  // whose orchestrator builds server environments first (e.g.
  // @cloudflare/vite-plugin's buildApp, which builds workers before client)
  // would bake a manifest-less fallback into the server bundle. Every user
  // of such a setup had to hand-write this ordering plugin; absorb it.
  //
  // Semantics:
  // - The first hook builds the client environment first, but only where
  //   the ordering matters: a client build that emits a manifest and
  //   actually has an input. It runs at *normal* order, deliberately not
  //   `pre`: pre-order buildApp hooks are where hosts do destructive
  //   preparation — nitro v3's `nitro:prepare` rm -rf's the whole output
  //   directory from a pre-order hook, so a pre-order client build sorted
  //   before it built into a directory that was then wiped (client assets
  //   and manifest gone, the manifest-less fallback baked into the server
  //   bundle, prod 500s). Normal order still runs before every known
  //   server-first orchestrator: a config-level `builder.buildApp`
  //   (@cloudflare/vite-plugin's workers-before-client orchestrator) is
  //   invoked by Vite only after all pre- and normal-order plugin hooks
  //   (just before the first post-order hook), and hook-based orchestrators
  //   (nitro's `nitro:main`, cloudflare's own companion hook) declare
  //   post order. Orchestrators running after skip the client via `isBuilt`
  //   (or at worst rebuild it, which is wasteful but correct — the manifest
  //   exists either way when the server environments build).
  // - Building anything from a hook suppresses Vite's own
  //   build-all-environments fallback (it only runs when *no* environment
  //   is built), so a setup with no real orchestrator — e.g. start mode's
  //   plain `builder: {}` — would end up with only the client built. The
  //   post-order hook reinstates exactly that fallback: when nothing but
  //   our own client build has happened and no other plugin stakes a claim
  //   on the app build, build the remaining environments in definition
  //   order, precisely what Vite would have done. Another plugin declaring
  //   a non-pre `buildApp` hook counts as such a claim even when it hasn't
  //   built anything yet (its post-order hook may sort after ours):
  //   building on its behalf would break staged orchestration (nitro
  //   prerenders and copies public assets before its final server bundle)
  //   and can error outright on environments the orchestrator knows to
  //   skip (e.g. ones with no rollup input). Pre-order hooks don't count —
  //   by convention they prepare (clean output dirs) rather than build.
  if (options.ssr) {
    let clientBuiltFirst = false;
    plugins.push(
      {
        name: 'solid:client-build-first',
        apply: 'build',
        async buildApp(builder) {
          const client = builder.environments.client;
          if (!client || client.isBuilt) return;
          const clientBuild = client.config.build;
          const hasInput =
            !!clientBuild.rollupOptions?.input ||
            existsSync(path.resolve(builder.config.root, 'index.html'));
          if (!clientBuild.manifest || !hasInput) return;
          await builder.build(client);
          clientBuiltFirst = true;
        },
      },
      {
        name: 'solid:client-build-first/complete',
        apply: 'build',
        buildApp: {
          order: 'post',
          async handler(builder) {
            if (!clientBuiltFirst) return;
            // Another plugin declares its own (non-pre) buildApp hook — the
            // app build is spoken for, even if that hook sorts after this
            // one and hasn't run yet.
            const otherOrchestrator = builder.config.plugins.some((p) => {
              if (!p.buildApp || p.name.startsWith('solid:client-build-first')) return false;
              return typeof p.buildApp !== 'object' || p.buildApp.order !== 'pre';
            });
            if (otherOrchestrator) return;
            const environments = Object.values(builder.environments);
            // A config-level orchestrator built something of its own — the
            // app build is spoken for, don't build environments it may have
            // skipped intentionally.
            if (environments.some((env) => env.isBuilt && env.name !== 'client')) return;
            for (const environment of environments) {
              if (!environment.isBuilt) await builder.build(environment);
            }
          },
        },
      },
    );
  }

  return plugins;
}

export type ViteManifest = Record<
  string,
  {
    file: string;
    css?: string[];
    isEntry?: boolean;
    isDynamicEntry?: boolean;
    imports?: string[];
  }
> & {
  _base?: string;
  /**
   * Manifest key of the client entry the document boots (the plugin's
   * injected start-mode entry, or the single configured input). Absent when
   * the plugin cannot tell the application entry apart from other configured
   * inputs; its record is also serialized first so first-`isEntry` scans
   * agree with it.
   */
  _entry?: string;
};
