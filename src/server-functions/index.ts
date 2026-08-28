// Hoisted from solid-start (packages/start/src/directives/index.ts).
//
// Standalone `"use server"` support for Vite. The compiler half of server
// functions lives here; the runtime half (registration on the server, a
// transport on the client) is @solidjs/web/server-functions by default —
// the compiled output imports `registerServerReference` /
// `createServerReference` from that specifier and the package's export
// conditions resolve the right half per environment. Any runtime satisfying
// that contract can be swapped in through `options.runtime` (SolidStart's,
// or your own).
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import path from 'path';
import {
  createFilter,
  type EnvironmentModuleGraph,
  type FilterPattern,
  type Plugin,
  type ViteDevServer,
} from 'vite';
import { getEnvironmentConsumer, isRunnableEnvironment } from '../environment.js';
import { joinBase, sendWebResponse, webRequestFromNode } from '../http.js';
import { isTsrxModule } from '../tsrx.js';
import { compile, type CompileOptions } from './compile.js';
import xxHash32 from './xxhash32.js';

/**
 * Picomatch patterns selecting the modules the directive compiler runs on.
 * Relative patterns (the defaults included) are resolved against the Vite
 * root — not the invocation directory — so running `vite` from outside the
 * project keeps compiling the same files. Absolute patterns are used as-is.
 *
 * @default include "src/**\/*.{jsx,tsx,tsrx,ts,js,mjs,cjs}", exclude "node_modules/**\/*.{jsx,tsx,tsrx,ts,js,mjs,cjs}"
 */
export interface ServerFunctionsFilter {
  include?: FilterPattern;
  exclude?: FilterPattern;
}

export interface ServerFunctionsOptions {
  /**
   * Module specifiers the compiled output imports the runtime from.
   * Each must export `registerServerReference(id, fn)` (server) and
   * `createServerReference(...)` (both sides).
   *
   * @default "@solidjs/web/server-functions" for both (the package's export
   * conditions resolve the client or server half per environment)
   */
  runtime?: {
    server: string;
    client: string;
  };
  /**
   * Virtual module id that imports every module containing server functions.
   * Import it for side effects in your server entry so all registrations
   * exist before requests are handled.
   *
   * @default "virtual:solid-server-function-manifest"
   */
  manifest?: string;
  filter?: ServerFunctionsFilter;
  /**
   * @default "use server"
   */
  directive?: string;
  /**
   * Path the server-function transport posts to. Joined with Vite `base`.
   * Threaded to the built-in dev middleware, the
   * `virtual:solid-server-function-handler` module, and — whenever the
   * resolved path differs from the runtime default (`/_server`) — runtime
   * `configureServerFunctions{Client,Server}` calls appended to compiled
   * modules (so custom runtimes used with a custom endpoint must export
   * those).
   *
   * @default "/_server"
   */
  endpoint?: string;
  /**
   * Whether the built-in dev middleware owns the server-function endpoint on
   * the Vite dev server. Only meaningful through the main plugin's
   * `serverFunctions` option (the standalone `serverFunctions()` export
   * never installs the middleware).
   *
   * Set `false` when another plugin's server environment should own
   * dispatch in dev — e.g. @cloudflare/vite-plugin, whose workerd
   * environment carries the bindings (`env`/`ctx`) your server functions
   * need: the middleware executes functions in Vite's node-side SSR
   * environment, so with it installed those requests never reach the
   * worker. With the middleware off, everything else keeps working —
   * compilation, the manifest and handler virtual modules — and endpoint
   * requests fall through to whatever the host serves; the host loads
   * `virtual:solid-server-function-handler` itself and dispatches through
   * its `handleServerFunctionRequest` export, exactly like production.
   * Functions referenced only by client code register on demand through
   * the middleware in dev, so a host owning dispatch should side-effect
   * import the manifest module in its server entry to cover them.
   *
   * When a provider owns the dev server's `ssr` environment (it isn't
   * runnable), the middleware already stands down automatically — no need
   * to set this. See `start.external` for the whole-server switch.
   *
   * @default true (stands down automatically when the `ssr` dev environment isn't runnable)
   */
  devMiddleware?: boolean;
  /**
   * Path to a server-only module (resolved relative to the Vite root, like
   * `start.document`) that the generated
   * `virtual:solid-server-function-handler` module side-effect imports
   * before configuring the runtime. A guaranteed pre-dispatch home for
   * server-side registration — typically `configureServerFunctionsServer`
   * calls whose config the app graph can't reliably install first, e.g. a
   * router's single-flight collector:
   *
   * ```ts
   * // src/server-config.ts
   * import { configureServerFunctionsServer } from '@solidjs/web/server-functions/server';
   * configureServerFunctionsServer({ collectFlightData: createFlightDataCollector(router) });
   * ```
   *
   * Because the module lives in the handler graph, it is evaluated before
   * any dispatch on every surface — the dev middleware and the production
   * handler alike — and is immune to the dev-restart race where
   * registration living in the app graph only loads with the first page
   * render (the handler graph loads before the first mutation). Config
   * calls merge per key, so it composes with the plugin's own
   * `configureServerFunctionsServer` call in the same module.
   *
   * @default undefined
   */
  configure?: string;
  /**
   * Enable server components (experimental): `"use server"` functions that
   * return a component. Responses for them are served over the
   * server-function endpoint as streamed HTML that the client runtime
   * applies in place of the boundary (instead of decoding it as data).
   *
   * The plugin's dispatch surfaces — the built-in dev middleware and the
   * `virtual:solid-server-function-handler` module — install the response
   * transform on the server runtime automatically, so this needs no
   * per-request wiring or server code.
   *
   * Document SSR of server components (rendered inline at t=0 and adopted
   * at boot with zero endpoint requests) needs three more pieces: the
   * render must run with the server-component render plugin, the document
   * must carry the bootstrap script, and the client must call
   * `installServerComponents()` before hydrating. With SSR start mode (the
   * main plugin's `start` option with `ssr: true`) and generated entries
   * the plugin emits all three. With authored entries those pieces live in
   * your entry files — import them from `@solidjs/web/frames` (see the
   * README).
   *
   * All of this is pure codegen: when the option is off, no reference to
   * the server-component runtime is emitted anywhere.
   *
   * @default false
   */
  components?: boolean;
}

const DEFAULT_INCLUDE = 'src/**/*.{jsx,tsx,tsrx,ts,js,mjs,cjs}';
const DEFAULT_EXCLUDE = 'node_modules/**/*.{jsx,tsx,tsrx,ts,js,mjs,cjs}';
const DEFAULT_MANIFEST = 'virtual:solid-server-function-manifest';
const DEFAULT_DIRECTIVE = 'use server';
const DEFAULT_RUNTIME = '@solidjs/web/server-functions';
// Must match the runtime's built-in default — when the resolved endpoint
// equals it, no configure calls need to be emitted at all.
const DEFAULT_ENDPOINT = '/_server';
const STORAGE_SOURCE = '@solidjs/web/storage';
// Server-only handler: importing it wires the endpoint in one line
// (registrations via the manifest, request-event scoping, endpoint config).
const HANDLER_ID = 'virtual:solid-server-function-handler';

// Server functions referenced only from client-side code (e.g. event
// handlers, which the SSR JSX compile drops) never get imported — or even
// transformed — by the server build, so their registrations would be missing
// at runtime. That's why the client transform records modules into the
// *server* manifest set. The dev server and Vite's builder mode share one
// process where that just works; the classic two-invocation build
// (`vite build` then `vite build --ssr`) does not, so the client build
// persists its findings for the SSR build to merge (mirroring the plugin's
// dist/client/.vite/manifest.json convention).
const PERSISTED_MANIFEST_PATH = '.vite/solid-server-functions.json';

function readPersistedManifest(root: string): Set<string> {
  const file = path.resolve(root, 'dist/client', PERSISTED_MANIFEST_PATH);
  if (!existsSync(file)) return new Set();
  try {
    const entries: string[] = JSON.parse(readFileSync(file, 'utf-8'));
    return new Set(
      entries.map((entry) => path.resolve(root, entry)).filter((entry) => existsSync(entry)),
    );
  } catch {
    return new Set();
  }
}

function writePersistedManifest(root: string, outDir: string, entries: Set<string>): void {
  const file = path.resolve(root, outDir, PERSISTED_MANIFEST_PATH);
  mkdirSync(path.dirname(file), { recursive: true });
  const relative = [...entries].map((entry) =>
    path.relative(root, entry).split(path.sep).join('/'),
  );
  writeFileSync(file, JSON.stringify(relative, null, 2));
}

type Manifest = Record<CompileOptions['mode'], Set<string>>;

function createManifest(): Manifest {
  return {
    server: new Set(),
    client: new Set(),
  };
}

interface DeferredPromise<T> {
  reference: Promise<T>;
  resolve: (value: T) => void;
  reject: (value: any) => void;
}

function createDeferredPromise<T>(): DeferredPromise<T> {
  let resolve: DeferredPromise<T>['resolve'];
  let reject: DeferredPromise<T>['reject'];

  return {
    reference: new Promise((res, rej) => {
      resolve = res;
      reject = rej;
    }),
    resolve(value) {
      resolve(value);
    },
    reject(value) {
      reject(value);
    },
  };
}

// The manifest can only be emitted once every module has been transformed
// (each transform may register new entries), but Vite gives no such signal —
// so the manifest load resolves a debounced snapshot that transforms keep
// pushing back while they are still landing.
class Debouncer<T> {
  promise: DeferredPromise<T>;

  private timeout: ReturnType<typeof setTimeout> | undefined;

  constructor(private source: () => T) {
    this.promise = createDeferredPromise();
    this.defer();
  }

  defer(): void {
    if (this.timeout) {
      clearTimeout(this.timeout);
      this.timeout = undefined;
    }
    this.timeout = setTimeout(() => {
      this.promise.resolve(this.source());
    }, 1000);
  }
}

function mergeManifestRecord(
  source: Set<string>,
  target: Set<string>,
): { invalidPreload: boolean; invalidated: string[] } {
  const current = source.size;
  for (const entry of target) {
    source.add(entry);
  }
  return {
    invalidPreload: current !== source.size,
    invalidated: [...source],
  };
}

function invalidateModule(moduleGraph: EnvironmentModuleGraph, path: string) {
  const target = moduleGraph.getModuleById(path);
  if (target) {
    moduleGraph.invalidateModule(target);
  }
}

function invalidateModules(
  server: ViteDevServer | undefined,
  result: ReturnType<typeof mergeManifestRecord>,
  manifest: string,
): void {
  if (server?.environments && result.invalidPreload) {
    invalidateModule(server.environments.client.moduleGraph, manifest);
    invalidateModule(server.environments.ssr.moduleGraph, manifest);
  }
}

/**
 * The second parameter is internal wiring for the main plugin's
 * `serverFunctions` option: the built-in dev middleware is only installed
 * through that path, so meta-frameworks composing this factory directly
 * (and dispatching to `handleServerFunctionRequest` themselves) never race
 * it for the endpoint. On the main plugin's path the public
 * `options.devMiddleware` (default true) can opt back out of it.
 */
export function serverFunctions(
  options: ServerFunctionsOptions = {},
  internal: {
    devMiddleware?: boolean;
    externalDevServer?: boolean;
    ssrHandler?: string;
    tsrxAfterSolid?: boolean;
    tsrxSourceMap?: boolean;
  } = {},
): Plugin[] {
  const filterInclude = options.filter?.include || DEFAULT_INCLUDE;
  const filterExclude = options.filter?.exclude || DEFAULT_EXCLUDE;
  // Recreated in configResolved: relative patterns (the defaults included)
  // must resolve against the Vite root, not process.cwd() — running `vite`
  // from outside the project would otherwise silently skip every module.
  let filter = createFilter(filterInclude, filterExclude);
  const manifestId = options.manifest || DEFAULT_MANIFEST;
  const directive = options.directive || DEFAULT_DIRECTIVE;
  const runtime = options.runtime || { server: DEFAULT_RUNTIME, client: DEFAULT_RUNTIME };
  const endpointOption = options.endpoint || DEFAULT_ENDPOINT;
  const endpoint = endpointOption.startsWith('/') ? endpointOption : '/' + endpointOption;
  const components = !!options.components;
  // The middleware only exists on the main plugin's path to begin with (see the
  // `internal` parameter doc); the public option opts out of it there.
  const installDevMiddleware = !!internal.devMiddleware && options.devMiddleware !== false;

  let env: CompileOptions['env'];
  let root = process.cwd();
  let base = '/';
  let isBuild = false;
  let isSsrBuild = false;
  let outDir = 'dist';
  // Endpoint with Vite `base` applied; final after configResolved, which
  // runs before every transform/load/middleware that reads it.
  let resolvedEndpoint = endpoint;
  // Absolute path of the user's `configure` module; resolved (and existence-
  // checked) in configResolved, before any handler load can read it.
  let configureModulePath: string | null = null;

  const manifest = createManifest();

  const preload: Record<CompileOptions['mode'], Debouncer<string> | undefined> = {
    server: undefined,
    client: undefined,
  };
  let currentServer: ViteDevServer | undefined;

  const clientOptions: Pick<CompileOptions, 'directive' | 'definitions'> = {
    directive,
    definitions: {
      register: {
        kind: 'named',
        name: 'registerServerReference',
        source: runtime.client,
      },
      create: {
        kind: 'named',
        name: 'createServerReference',
        source: runtime.client,
      },
    },
  };
  const serverOptions: Pick<CompileOptions, 'directive' | 'definitions'> = {
    directive,
    definitions: {
      register: {
        kind: 'named',
        name: 'registerServerReference',
        source: runtime.server,
      },
      create: {
        kind: 'named',
        name: 'createServerReference',
        source: runtime.server,
      },
    },
  };

  // A non-default endpoint (custom option, or Vite `base` prefixing the
  // default) must reach the runtime on both sides — the client transport
  // reads it for every fetch, the server for rendered reference `.url`s.
  // References are only reachable through compiled modules, so appending the
  // configure call to each guarantees it runs before any reference is used.
  // The default endpoint appends nothing, keeping compiled output byte-
  // identical for setups that wire the runtime themselves.
  function endpointConfigureSnippet(mode: CompileOptions['mode']): string {
    if (resolvedEndpoint === DEFAULT_ENDPOINT) return '';
    const name =
      mode === 'server' ? 'configureServerFunctionsServer' : 'configureServerFunctionsClient';
    const source = mode === 'server' ? runtime.server : runtime.client;
    return (
      `\nimport { ${name} as $$configureServerFunctions } from ${JSON.stringify(source)};` +
      `\n$$configureServerFunctions({ endpoint: ${JSON.stringify(resolvedEndpoint)} });\n`
    );
  }

  // Dev omits the manifest import: the middleware loads the referenced
  // module on demand instead (importing the debounced manifest would stall
  // the first request and eagerly SSR-load every server-function module).
  // Builds import it so tree-shaking can't drop registrations for functions
  // only client code references.
  function handlerModuleCode(includeManifest: boolean): string {
    // Server components ride the frame-stream wire protocol: the transform
    // serves a function's component result as streamed HTML instead of data.
    // Installing it here (config-level, merged with the other keys) covers
    // both dispatch surfaces — the dev middleware and the prod handler load
    // this module before dispatching — with zero per-request wiring. The
    // import is only emitted when the option is on, so disabled setups keep
    // a server-component-free graph.
    return [
      // The user's `configure` module comes first: a side-effect import in
      // the handler graph, evaluated before any dispatch on both surfaces
      // (dev middleware and prod handler) and bundled into the handler
      // chunk by production builds. Order relative to the configure call
      // below doesn't actually matter — runtime config merges per key —
      // import-first is just the cleaner shape.
      ...(configureModulePath ? [`import ${JSON.stringify(configureModulePath)};`] : []),
      ...(includeManifest ? [`import ${JSON.stringify(manifestId)};`] : []),
      `import { handleServerFunctionRequest as handle, configureServerFunctionsServer } from ${JSON.stringify(runtime.server)};`,
      `import { provideRequestEvent } from ${JSON.stringify(STORAGE_SOURCE)};`,
      ...(components
        ? [
            `import { frameTransformResult, frameTransformFlightResult, frameTransformDirectResult } from '@solidjs/web/frames';`,
          ]
        : []),
      // `transformFlightResult` is the single-flight leg of the same wire
      // protocol: a mutation whose invalidated payload includes markup gets
      // the frame stream as its carrier (regions + envelope in one
      // response). It only runs when a router registered a collectFlightData
      // hook, so installing it unconditionally alongside the result
      // transform costs disabled setups nothing.
      //
      // `transformDirectResult` is ALSO installed here — not just in the
      // generated SSR entry — because flight collection makes direct
      // (in-process) calls during handler dispatch, and the transform is what
      // brands their results with the call address the client matches showing
      // boundaries against. The SSR entry usually loads first and installs
      // the same value (config merges per key), but the handler graph cannot
      // depend on that: in dev, a mutation from an already-open page can be
      // the first request after a server restart.
      `configureServerFunctionsServer({ provideEvent: provideRequestEvent, endpoint: ${JSON.stringify(resolvedEndpoint)}${
        components
          ? ', transformResult: frameTransformResult, transformFlightResult: frameTransformFlightResult, transformDirectResult: frameTransformDirectResult'
          : ''
      } });`,
      `export const endpoint = ${JSON.stringify(resolvedEndpoint)};`,
      // `options.event` is the same wrapper->event extension seam the SSR
      // handler's handleRequest carries (conventionally `nativeEvent`, the
      // platform's raw request object). The runtime's standalone handler
      // creates its own event (`{ request, locals }`) with no init
      // parameter, so the extension threads through its existing
      // `createEvent` option instead — spread before `...options` so an
      // explicit host-provided createEvent still wins.
      `export function handleServerFunctionRequest(request, options) {`,
      `  const { event: eventInit, ...rest } = options || {};`,
      `  return handle(request, {`,
      `    provideEvent: provideRequestEvent,`,
      `    ...(eventInit ? { createEvent: (req) => ({ request: req, locals: {}, ...eventInit }) } : {}),`,
      `    ...rest,`,
      `  });`,
      `}`,
    ].join('\n');
  }

  // Function IDs are `<name>-<xxHash32(root-relative path)>[-<ordinal>]`
  // (identity-keyed, solidjs/solid#3109). The name is a JS identifier and
  // never contains `-`, so the hash is always the second segment and maps
  // an incoming ID back to its module. Rebuilt whenever a transform has
  // grown the manifest.
  const hashIndex = new Map<string, string>();
  let hashIndexSize = -1;
  function moduleForFunctionId(functionId: string): string | undefined {
    if (manifest.server.size !== hashIndexSize) {
      hashIndex.clear();
      for (const entry of manifest.server) {
        const relative = path.relative(root, entry).split(path.sep).join('/');
        hashIndex.set(xxHash32(relative).toString(16), entry);
      }
      hashIndexSize = manifest.server.size;
    }
    return hashIndex.get(functionId.split('-')[1]!);
  }

  function moduleDevUrl(entry: string): string {
    const relative = path.relative(root, entry).split(path.sep).join('/');
    return relative.startsWith('..') ? '/@fs/' + entry : '/' + relative;
  }

  const startPlugins: Plugin[] = [
    {
      name: 'solid:server-functions/handler',
      enforce: 'pre',
      resolveId(source, _importer, opts) {
        if (source === HANDLER_ID) {
          if (getEnvironmentConsumer(this.environment, opts) !== 'server') {
            this.error(
              `${HANDLER_ID} is server-only; import it from your server entry (SSR build).`,
            );
          }
          return { id: HANDLER_ID, moduleSideEffects: true };
        }
        return null;
      },
      load(id, opts) {
        if (id === HANDLER_ID && getEnvironmentConsumer(this.environment, opts) === 'server') {
          const externalDev =
            this.environment.mode === 'dev' &&
            (internal.externalDevServer || !isRunnableEnvironment(this.environment));
          return handlerModuleCode(isBuild || externalDev);
        }
        return null;
      },
    },
  ];

  if (installDevMiddleware) {
    startPlugins.push({
      name: 'solid:server-functions/dev-middleware',
      apply: 'serve',
      configureServer(server) {
        const ssrEnvironment = server.environments.ssr;
        if (internal.externalDevServer || !isRunnableEnvironment(ssrEnvironment)) {
          return;
        }
        // A call's address is `<endpoint>/<id>` — plain HTTP — or
        // `<endpoint>/data/<id>` — the scripted transport's own path
        // (solidjs/solid#3076, #3094). Bare-mount requests still reach the
        // runtime handler (it answers 404), so misdirected posts fail
        // through the endpoint rather than falling through to SSR.
        const underMount = (pathname: string, mount: string) =>
          pathname === mount || pathname.startsWith(mount + '/');
        server.middlewares.use((req, res, next) => {
          const url = new URL(req.url || '/', 'http://localhost');
          // Match with and without `base` — middleware-mode hosts may mount
          // vite.middlewares below the base themselves.
          if (!underMount(url.pathname, resolvedEndpoint) && !underMount(url.pathname, endpoint)) {
            return next();
          }
          const basePrefixed = underMount(url.pathname, resolvedEndpoint);
          // When the stripped form matched, restore the base for dispatch:
          // the generated handler compares the request pathname against the
          // base-prefixed endpoint, and production handlers only ever see
          // base-prefixed URLs.
          const dispatchUrl = basePrefixed ? undefined : joinBase(base, req.url || '/');
          (async () => {
            // Make sure the referenced module has been evaluated in the SSR
            // environment so its registration exists — functions only client
            // code references are never loaded by the SSR render itself.
            // The id lives in the path segment after the mount — behind a
            // literal `data` segment on the scripted transport's address
            // (solidjs/solid#3094). Segment count keeps the two apart: an id
            // occupies exactly one segment, so `data/<id>` is only ever a
            // data address, and a function id spelled `data` still parses at
            // the bare one.
            const mount = basePrefixed ? resolvedEndpoint : endpoint;
            let segment = url.pathname.slice(mount.length + 1);
            if (segment.startsWith('data/')) segment = segment.slice(5);
            let functionId: string | null = null;
            if (segment && !segment.includes('/')) {
              try {
                functionId = decodeURIComponent(segment);
              } catch {
                // not an address; the runtime handler answers the 404
              }
            }
            if (functionId) {
              const entry = moduleForFunctionId(functionId);
              if (entry) await ssrEnvironment.runner.import(moduleDevUrl(entry));
            }
            // Dispatch through a module evaluated in the SSR environment so
            // the handler shares the registry instance with the app modules.
            // With SSR start mode active the main plugin threads its handler id
            // in, and dispatch goes through `handleRequest` instead — one
            // middleware chain and one stub-backed request event front the
            // endpoint exactly as they front page SSR.
            const handler = await ssrEnvironment.runner.import(internal.ssrHandler ?? HANDLER_ID);
            // Both dispatch shapes carry the raw Node request on the event
            // (the `options.event` seam), matching the SSR dev middleware
            // and what a production Node entry passes.
            const dispatchOptions = { event: { nativeEvent: req } };
            const response: Response = internal.ssrHandler
              ? await handler.handleRequest(
                  webRequestFromNode(req, dispatchUrl, res),
                  dispatchOptions,
                )
              : await handler.handleServerFunctionRequest(
                  webRequestFromNode(req, dispatchUrl, res),
                  dispatchOptions,
                );
            await sendWebResponse(res, response);
          })().catch((error) => {
            next(error);
          });
        });
      },
    });
  }

  async function transformModule(
    ctx: any,
    code: string,
    fileId: string,
    opts: unknown,
    tsrx: boolean,
  ) {
    const mode = getEnvironmentConsumer(ctx.environment, opts);
    const [id] = fileId.split('?');
    if (!id || !filter(id) || isTsrxModule(id) !== tsrx) return null;

    // The directive has to appear literally, so anything without the
    // substring can skip the native parse entirely.
    if (!code.includes(directive)) return null;

    const result = await compile(id, code, {
      ...(mode === 'server' ? serverOptions : clientOptions),
      mode,
      env,
      root,
      sourceMap: !tsrx || !!internal.tsrxSourceMap,
    });

    if (!result.valid) return null;

    const preloader = preload[mode];
    if (preloader) preloader.defer();
    invalidateModules(
      currentServer,
      mergeManifestRecord(manifest.server, new Set([id])),
      manifestId,
    );

    return {
      // Appended (not prepended) so the source map for the compiled module
      // stays valid; imports hoist and the endpoint is only read at call time.
      code: (result.code || '') + endpointConfigureSnippet(mode),
      map: result.map,
    };
  }

  const compilerPlugin: Plugin = {
    name: 'solid:server-functions/compiler',
    enforce: 'pre',
    transform(code, fileId, opts) {
      return transformModule(this, code, fileId, opts, false);
    },
  };

  const tsrxCompilerPlugin: Plugin = {
    name: 'solid:server-functions/tsrx-compiler',
    enforce: 'pre',
    transform(code, fileId, opts) {
      return transformModule(this, code, fileId, opts, true);
    },
  };

  return [
    {
      name: 'solid:server-functions/setup',
      enforce: 'pre',
      configResolved(config) {
        env = config.mode !== 'production' ? 'development' : 'production';
        root = config.root;
        base = config.base;
        filter = createFilter(filterInclude, filterExclude, { resolve: root });
        isBuild = config.command === 'build';
        isSsrBuild = !!config.build.ssr;
        outDir = config.build.outDir;
        resolvedEndpoint = joinBase(config.base, endpoint);
        if (options.configure) {
          const absolute = path.isAbsolute(options.configure)
            ? options.configure
            : path.resolve(root, options.configure);
          if (!existsSync(absolute)) {
            throw new Error(
              `[@solidjs/vite-plugin] serverFunctions.configure does not exist: ${options.configure}`,
            );
          }
          configureModulePath = absolute;
        }
        if (isBuild && isSsrBuild) {
          // Classic two-invocation build: pick up the modules the client
          // build discovered so the server manifest registers them even when
          // the SSR module graph never imports them.
          for (const entry of readPersistedManifest(root)) {
            manifest.server.add(entry);
          }
        }
      },
      configureServer(server) {
        currentServer = server;
      },
      writeBundle() {
        // Same client-build detection as the main plugin: builder-mode builds
        // run both environments in one process, so prefer the per-environment
        // consumer over the process-wide --ssr flag.
        const ctx = this as { environment?: { config?: { consumer?: string } } };
        const consumer = ctx.environment?.config?.consumer;
        const isClient = consumer ? consumer === 'client' : !isSsrBuild;
        if (isBuild && isClient) {
          writePersistedManifest(root, outDir, manifest.server);
        }
      },
    },
    {
      name: 'solid:server-functions/manifest',
      enforce: 'pre',
      resolveId(source) {
        if (source === manifestId) {
          return { id: manifestId, moduleSideEffects: true };
        }
        return null;
      },
      async load(id, opts) {
        const mode = getEnvironmentConsumer(this.environment, opts);
        if (id === manifestId) {
          if (isBuild && mode === 'server') {
            // Merge the client build's persisted discoveries at load time,
            // not just configResolved: in builder mode (single process,
            // `vite build` with the environments API) all environment
            // configs resolve before the client build has written the file,
            // but this load runs once the SSR environment builds — after it.
            for (const entry of readPersistedManifest(root)) {
              manifest.server.add(entry);
            }
          }
          const current = new Debouncer(() =>
            [...manifest[mode]].map((entry) => `import ${JSON.stringify(entry)};`).join('\n'),
          );
          preload[mode] = current;
          const result = await current.promise.reference;
          return result;
        }
        return null;
      },
    },
    compilerPlugin,
    ...(internal.tsrxAfterSolid ? [tsrxCompilerPlugin] : []),
    ...startPlugins,
  ];
}
