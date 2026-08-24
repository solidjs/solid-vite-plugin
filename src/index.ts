import * as babel from '@babel/core';
import type { TransformOptions as JsxCompilerOptions } from '@dom-expressions/compiler';
import remapping from '@ampproject/remapping';
import solid from 'babel-preset-solid';
import { existsSync, readFileSync } from 'fs';
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

import { serverFunctions, type ServerFunctionsOptions } from './server-functions/index.js';
import { SSR_HANDLER_ID, startServe, type StartOptions } from './ssr/index.js';
import { startEnv } from './start-env.js';

export { devStylePatch } from './dev-manifest.js';
export { serverFunctions };
export type { ServerFunctionsOptions };
export type { ServerFunctionsFilter } from './server-functions/index.js';
export type { StartOptions };
import path from 'path';
import type { FilterPattern, Plugin, ViteDevServer } from 'vite';
import { createFilter, defaultClientConditions, defaultServerConditions } from 'vite';
import { getEnvironmentConsumer, isRunnableEnvironment } from './environment.js';
import { crawlFrameworkPkgs } from 'vitefu';

const require = createRequire(import.meta.url);

/**
 * The `lazy()` module-URL placeholder contract, shared with the native
 * compiler's `transformLazy` pass: `lazy(() => import("spec"))` calls gain a
 * second string-literal argument of the form
 * `"__SOLID_LAZY_MODULE__:" + spec`, which `resolveLazyModuleUrls` swaps for
 * the project-relative resolved module path. The prefix and shape are FROZEN
 * — the emitting side lives in @dom-expressions/compiler and must match.
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

const SOLID_BUILT_INS = [
  'For',
  'Show',
  'Switch',
  'Match',
  'Loading',
  'Reveal',
  'Portal',
  'Repeat',
  'Dynamic',
  'Errored',
];

/** Possible options for the extensions property */
export interface ExtensionOptions {
  typescript?: boolean;
}

export type Compiler = 'babel' | 'native';
// `serverComponents` ships in @dom-expressions/compiler's TransformOptions
// from 0.50.0-next.44; the intersection member is redundant (and droppable)
// once the dependency floor moves past it.
export type SolidOptions = Omit<JsxCompilerOptions, 'filename' | 'sourceMap'> & {
  serverComponents?: boolean;
};
type NativeCompiler = typeof import('@dom-expressions/compiler');
let nativeCompilerPromise: Promise<NativeCompiler> | undefined;

async function loadNativeCompiler() {
  try {
    return await (nativeCompilerPromise ??= import('@dom-expressions/compiler'));
  } catch (error) {
    nativeCompilerPromise = undefined;
    const reason = error instanceof Error ? `\n\nCause: ${error.message}` : '';
    throw new Error(
      '@solidjs/vite-plugin: failed to load @dom-expressions/compiler, which is required ' +
        'in every mode (it drives the lazy, refresh, and server-function transforms; ' +
        'compiler: "babel" only switches the JSX transform). Your platform should get ' +
        'a prebuilt native binary or the @dom-expressions/compiler-wasm32-wasi fallback ' +
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
   * This will inject solid-js/dev in place of solid-js in dev mode. Has no
   * effect in prod. If set to `false`, it won't inject it in dev. This is
   * useful for extra logs and debugging.
   *
   * @default true
   */
  dev?: boolean;
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
   *   its `handleRequest` serves the endpoint (pages stay static).
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
   * `@dom-expressions/compiler`; `"babel"` is the escape hatch running
   * `babel-preset-solid` instead — if native output ever differs from your
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
   * @solidjs/vite-plugin.
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
   * host them.
   *
   * @default {}
   */
  babel?:
    | babel.TransformOptions
    | ((source: string, id: string, ssr: boolean) => babel.TransformOptions)
    | ((source: string, id: string, ssr: boolean) => Promise<babel.TransformOptions>);
  /**
   * Pass any additional [babel-plugin-jsx-dom-expressions](https://github.com/ryansolid/dom-expressions/tree/main/packages/babel-plugin-jsx-dom-expressions#plugin-options).
   * They will be merged with the defaults sets by [babel-preset-solid](https://github.com/solidjs/solid/blob/main/packages/babel-preset-solid/index.js#L8-L25).
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

function getJestDomExport(setupFiles: string[]) {
  return setupFiles?.some((path) => /jest-dom/.test(path))
    ? undefined
    : ['@testing-library/jest-dom/vitest', '@testing-library/jest-dom/extend-expect'].find(
        (path) => {
          try {
            require.resolve(path);
            return true;
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
  // behavior-claims transform: ref/on* positions on intrinsic elements
  // compile to guarded `_bnd` claim holes instead of dropping. SSR-only
  // by construction (the dom generate ignores the flag), and apps without
  // the flag compile byte-for-byte as before.
  const serverComponents =
    typeof options.serverFunctions === 'object' && !!options.serverFunctions.components;

  return {
    moduleName: '@solidjs/web',
    builtIns: SOLID_BUILT_INS,
    contextToCustomElements: true,
    wrapConditionals: true,
    ...solidOptions,
    ...(serverComponents && solidOptions.generate === 'ssr' ? { serverComponents: true } : {}),
    dev,
    ...(options.solid || {}),
  };
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

/**
 * Chunks emitted for lazy() targets are marked `isEntry` by Rollup even
 * though they are semantically dynamic entries. Reclassify any entry that is
 * dynamically imported by another chunk so the runtime's entry-asset
 * detection (which keys off `isEntry`) can't pick a lazy facade instead of
 * the real client entry. Works on both the Vite manifest.json shape and the
 * raw Rollup output bundle — both key entries by name and expose
 * `dynamicImports` / `isEntry` with the same meaning.
 */
function normalizeEmittedLazyEntries(manifest: Record<string, any>) {
  const dynamicKeys = new Set<string>();
  for (const key in manifest) {
    const imports: string[] | undefined = manifest[key].dynamicImports;
    if (imports) for (const dep of imports) dynamicKeys.add(dep);
  }
  for (const key of dynamicKeys) {
    const entry = manifest[key];
    if (entry && entry.isEntry) {
      entry.isEntry = false;
      entry.isDynamicEntry = true;
    }
  }
}

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
  const serverComponents =
    typeof options.serverFunctions === 'object' && !!options.serverFunctions.components;
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

  let needHmr = false;
  let replaceDev = false;
  // The live dev server, kept so the dev manifest module can bake the bridge
  // endpoint URL in when its code is generated (see devManifestBridgeUrl).
  let devServer: ViteDevServer | null = null;
  let projectRoot = process.cwd();
  let isTestMode = false;
  let serverTestPosture = false;
  let isBuild = false;
  let isSsrBuild = false;
  let base = '/';
  let clientOutDir: string | null = null;
  let solidPkgsConfig: Awaited<ReturnType<typeof crawlFrameworkPkgs>>;

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

  const mainPlugin: Plugin = {
    name: 'solid',
    enforce: 'pre',

    async config(userConfig, { command }) {
      // We inject the dev mode only if the user explicitly wants it or if we are in dev (serve) mode
      replaceDev = options.dev === true || (options.dev !== false && command === 'serve');
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
      });

      // fix for bundling dev in production
      const nestedDeps = replaceDev ? ['solid-js', '@solidjs/web'] : [];

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
        if (!userTest.environment && !userTest.browser?.enabled) {
          test.environment = 'jsdom';
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
          const jestDomImport = getJestDomExport(userSetupFiles);
          if (jestDomImport) {
            test.setupFiles = [jestDomImport];
          }
        }
      }

      return {
        /**
         * We only need esbuild on .ts or .js files.
         * .tsx & .jsx files are handled by us
         */
        // esbuild: { include: /\.ts$/ },
        // resolve.conditions is handled per-environment in configEnvironment.
        resolve: {
          dedupe: nestedDeps,
        },
        optimizeDeps: {
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
            ...solidPkgsConfig.optimizeDeps.include,
          ],
          exclude: solidPkgsConfig.optimizeDeps.exclude,
          // Keep Solid TSX from injecting React's automatic runtime during scanning.
          rolldownOptions: { transform: { jsx: { runtime: 'classic' as const } } },
        },
        ...(Object.keys(test).length ? { test } : {}),
      };
    },

    configEnvironment(name, config, opts) {
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
        // Tests resolve the browser builds even when the app is
        // server-rendered — the client posture applies to the whole test
        // pipeline, not just the codegen. Projects that explicitly opt into
        // a server runtime (`test.environment: 'node'` / 'edge-runtime')
        // keep the default server conditions instead, so the framework's
        // real server build resolves (isServer true).
        ...(isTestMode && !serverTestPosture && !opts.isSsrTargetWebworker ? ['browser'] : []),
        ...config.resolve.conditions,
      ];

      // Set resolve.noExternal and resolve.external for the SSR environment.
      // Only set resolve.external if noExternal is not true (to avoid conflicts with plugins like Cloudflare)
      if (name === 'ssr' && solidPkgsConfig) {
        if (config.resolve.noExternal !== true) {
          config.resolve.noExternal = [
            ...(Array.isArray(config.resolve.noExternal) ? config.resolve.noExternal : []),
            ...solidPkgsConfig.ssr.noExternal,
          ];
          config.resolve.external = [
            ...(Array.isArray(config.resolve.external) ? config.resolve.external : []),
            ...solidPkgsConfig.ssr.external,
          ];
        }
      }
    },

    configResolved(config) {
      isBuild = config.command === 'build';
      isSsrBuild = !!config.build.ssr;
      base = config.base;
      projectRoot = config.root;
      filter = createFilter(options.include, options.exclude, { resolve: projectRoot });
      styleFilter = createStyleFilter(projectRoot);
      if (serverComponents && !(options.start && options.ssr)) {
        config.logger.warn(
          '[@solidjs/vite-plugin] serverFunctions.components is set without SSR start mode (the `start` ' +
            'option with `ssr: true`), so the plugin only installs the endpoint response transform ' +
            '(server functions returning components stream correctly). The document wiring — render ' +
            'plugin, bootstrap script, and the client-side installServerComponents() call — is ' +
            "emitted by SSR start mode's generated entries; without it, server components only mount " +
            'from post-boot streams and your client code must call installServerComponents() itself.',
        );
      }
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

    hotUpdate({ modules }) {
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
        }
        return [];
      }
    },

    resolveId(id) {
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
        if (!/\.[mc]?[tj]sx?$/i.test(cleanId)) continue;
        if (emittedLazyChunks.has(depId)) continue;
        emittedLazyChunks.add(depId);
        emittedLazyChunkRefs.push(
          this.emitFile({ type: 'chunk', id: depId, preserveSignature: 'exports-only' }),
        );
      }
    },

    load(id) {
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
          normalizeEmittedLazyEntries(manifest);
          manifest._base = base;
          return `export default ${JSON.stringify(manifest)};`;
        }
        // SSR build before the client build produced a manifest: bake in the
        // dev-shaped fallback (registry miss degrades to js-only resolution).
        return devManifestCode(projectRoot, base, null);
      }
    },

    generateBundle(outputOptions, bundle) {
      if (!isBuild || !isClientBuild(this)) return;
      clientOutDir = outputOptions.dir ?? null;
      // Reclassify emitted lazy facade chunks in the raw bundle (not just the
      // serialized manifest read back later) so downstream plugins inspecting
      // the bundle don't mistake them for application entries. Must precede
      // the client asset map build, which keys off dynamic entries.
      if (options.ssr) {
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
          chunk.isEntry = false;
          chunk.isDynamicEntry = true;
        }
        normalizeEmittedLazyEntries(bundle);
      }
    },

    async transform(source, id, transformOptions) {
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

      if (!(/\.[mc]?[tj]sx$/i.test(id) || allExtensions.includes(currentFileExtension))) {
        return null;
      }

      const inNodeModules = /node_modules/.test(id);
      const solidOptions = getSolidOptions(options, !!isSsr, replaceDev, isTestMode);

      // We need to know if the current file extension has a typescript options tied to it
      const shouldBeProcessedWithTypescript =
        /\.[mc]?tsx$/i.test(id) ||
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

      const needRefresh = needHmr && !isSsr && !inNodeModules;

      const babelUserOptions = await getBabelUserOptions(options, source, id, !!isSsr);

      // The native compiler picks its parser dialect from the file
      // extension; custom extensions registered through `options.extensions`
      // are unknown to it, so borrow a standard one matching the configured
      // TypeScript-ness.
      const nativeFilename = /\.(?:[mc]?[jt]s|[jt]sx)$/i.test(id)
        ? id
        : id + (shouldBeProcessedWithTypescript ? '.tsx' : '.jsx');

      // Shared native prelude for every mode: the lazy() module-URL pass,
      // then (dev/client/non-node_modules) the solid-refresh HMR pass, both
      // operating on pre-JSX source. Only the JSX transform itself differs
      // between compiler backends. Sourcemaps are collected in application
      // order and merged at the end.
      const compiler = await loadNativeCompiler();
      let code = source;
      const maps: ChainableMap[] = [];

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

        return { code: finalCode, map: combineSourcemaps(maps) };
      }

      // Babel JSX backend: one babel.transformAsync hosting the user's
      // options plus babel-preset-solid.
      const babelOptions = mergeAndConcat(babelUserOptions, {
        ...babelBaseOptions,
        presets: [[solid, solidOptions]],
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

      return { code: finalCode, map: combineSourcemaps(maps) };
    },
  };

  // The directive transform must run before the JSX transform (it operates
  // on raw directives, and client-mode module-level extraction must happen
  // before templates are generated), so its sub-plugins go first. The
  // boundary markers (`server-only` / `client-only`) are always on.
  const plugins: Plugin[] = options.serverFunctions
    ? [
        boundaryModules(),
        ...serverFunctions(options.serverFunctions === true ? {} : options.serverFunctions, {
          devMiddleware: true,
          externalDevServer,
          // With start mode on (either variant), the dev middleware dispatches
          // the endpoint through the SSR handler so user middleware and the
          // stub-backed request event front it exactly like page SSR.
          ...(startOptions ? { ssrHandler: SSR_HANDLER_ID } : {}),
        }),
        mainPlugin,
      ]
    : [boundaryModules(), mainPlugin];

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
        serverComponents,
        ssr: !!options.ssr,
        styleFilter: filterDevStyles,
      }),
    );
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
};
