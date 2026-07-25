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
  isRunnableDevEnvironment,
  type EnvironmentModuleGraph,
  type FilterPattern,
  type Plugin,
  type ViteDevServer,
} from 'vite';
import { joinBase, sendWebResponse, webRequestFromNode } from '../http.js';
import { compile, type CompileOptions } from './compile.js';
import xxHash32 from './xxhash32.js';

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
   * Threaded to the turnkey dev middleware, the
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
   * Whether the turnkey dev middleware owns the server-function endpoint on
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
   * @default true
   */
  devMiddleware?: boolean;
  /**
   * Path to a server-only module (resolved relative to the Vite root, like
   * `ssr.document`) that the generated
   * `virtual:solid-server-function-handler` module side-effect imports
   * before configuring the runtime. A guaranteed pre-dispatch home for
   * server-side registration — typically `configureServerFunctionsServer`
   * calls whose config the app graph can't reliably install first, e.g. a
   * router's single-flight collector:
   *
   * ```ts
   * // src/server-config.ts
   * import { configureServerFunctionsServer } from '@solidjs/web/server-functions';
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
   * The plugin's dispatch surfaces — the turnkey dev middleware and the
   * `virtual:solid-server-function-handler` module — install the response
   * transform on the server runtime automatically, so this needs no
   * per-request wiring or server code.
   *
   * Document SSR of server components (rendered inline at t=0 and adopted
   * at boot with zero endpoint requests) needs three more pieces: the
   * render must run with the server-component render plugin, the document
   * must carry the bootstrap script, and the client must call
   * `installServerComponents()` before hydrating. With turnkey SSR (the
   * object form of the main plugin's `ssr` option) and generated entries
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

const DEFAULT_INCLUDE = 'src/**/*.{jsx,tsx,ts,js,mjs,cjs}';
const DEFAULT_EXCLUDE = 'node_modules/**/*.{jsx,tsx,ts,js,mjs,cjs}';
const DEFAULT_MANIFEST = 'virtual:solid-server-function-manifest';
const DEFAULT_DIRECTIVE = 'use server';
const DEFAULT_RUNTIME = '@solidjs/web/server-functions';
// Must match the runtime's built-in default — when the resolved endpoint
// equals it, no configure calls need to be emitted at all.
const DEFAULT_ENDPOINT = '/_server';
const STORAGE_SOURCE = '@solidjs/web/storage';
// Server-only turnkey handler: importing it wires the endpoint in one line
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
  // `environments` requires Vite 6+; older versions just miss the eager
  // manifest invalidation (the debounced reload still converges).
  if (server?.environments && result.invalidPreload) {
    invalidateModule(server.environments.client.moduleGraph, manifest);
    invalidateModule(server.environments.ssr.moduleGraph, manifest);
  }
}

/**
 * The second parameter is internal wiring for the main plugin's
 * `serverFunctions` option: the turnkey dev middleware is only installed
 * through that path, so meta-frameworks composing this factory directly
 * (and dispatching to `handleServerFunctionRequest` themselves) never race
 * it for the endpoint. On the turnkey path the public
 * `options.devMiddleware` (default true) can opt back out of it.
 */
export function serverFunctions(
  options: ServerFunctionsOptions = {},
  internal: { devMiddleware?: boolean; externalDevServer?: boolean } = {},
): Plugin[] {
  const filter = createFilter(
    options.filter?.include || DEFAULT_INCLUDE,
    options.filter?.exclude || DEFAULT_EXCLUDE,
  );
  const manifestId = options.manifest || DEFAULT_MANIFEST;
  const directive = options.directive || DEFAULT_DIRECTIVE;
  const runtime = options.runtime || { server: DEFAULT_RUNTIME, client: DEFAULT_RUNTIME };
  const endpointOption = options.endpoint || DEFAULT_ENDPOINT;
  const endpoint = endpointOption.startsWith('/') ? endpointOption : '/' + endpointOption;
  const components = !!options.components;
  // The middleware only exists on the turnkey path to begin with (see the
  // `internal` parameter doc); the public option opts out of it there.
  const installDevMiddleware = !!internal.devMiddleware && options.devMiddleware !== false;

  let env: CompileOptions['env'];
  let root = process.cwd();
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
      ...(components ? [`import { frameTransformResult } from '@solidjs/web/frames';`] : []),
      `configureServerFunctionsServer({ provideEvent: provideRequestEvent, endpoint: ${JSON.stringify(resolvedEndpoint)}${
        components ? ', transformResult: frameTransformResult' : ''
      } });`,
      `export const endpoint = ${JSON.stringify(resolvedEndpoint)};`,
      `export function handleServerFunctionRequest(request, options) {`,
      `  return handle(request, { provideEvent: provideRequestEvent, ...options });`,
      `}`,
    ].join('\n');
  }

  // Function IDs are `xxHash32(root-relative path)-<count>` (see compile.ts),
  // so the hash segment maps an incoming ID back to its module. Rebuilt
  // whenever a transform has grown the manifest.
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
    return hashIndex.get(functionId.split('-', 1)[0]!);
  }

  function moduleDevUrl(entry: string): string {
    const relative = path.relative(root, entry).split(path.sep).join('/');
    return relative.startsWith('..') ? '/@fs/' + entry : '/' + relative;
  }

  const turnkeyPlugins: Plugin[] = [
    {
      name: 'solid:server-functions/handler',
      enforce: 'pre',
      resolveId(source, _importer, opts) {
        if (source === HANDLER_ID) {
          if (!opts?.ssr) {
            this.error(
              `${HANDLER_ID} is server-only; import it from your server entry (SSR build).`,
            );
          }
          return { id: HANDLER_ID, moduleSideEffects: true };
        }
        return null;
      },
      load(id, opts) {
        if (id === HANDLER_ID && opts?.ssr) {
          const externalDev =
            this.environment.mode === 'dev' &&
            (internal.externalDevServer || !isRunnableDevEnvironment(this.environment));
          return handlerModuleCode(isBuild || externalDev);
        }
        return null;
      },
    },
  ];

  if (installDevMiddleware) {
    turnkeyPlugins.push({
      name: 'solid:server-functions/dev-middleware',
      apply: 'serve',
      configureServer(server) {
        const ssrEnvironment = server.environments.ssr;
        if (
          internal.externalDevServer ||
          (ssrEnvironment && !isRunnableDevEnvironment(ssrEnvironment))
        ) {
          return;
        }
        server.middlewares.use((req, res, next) => {
          const url = new URL(req.url || '/', 'http://localhost');
          // Match with and without `base` — middleware-mode hosts may mount
          // vite.middlewares below the base themselves.
          if (url.pathname !== resolvedEndpoint && url.pathname !== endpoint) {
            return next();
          }
          (async () => {
            // Make sure the referenced module has been evaluated in the SSR
            // environment so its registration exists — functions only client
            // code references are never loaded by the SSR render itself.
            const headerId = req.headers['x-server-function-id'];
            const functionId =
              (typeof headerId === 'string' ? headerId.split('#')[0] : undefined) ||
              url.searchParams.get('id');
            if (functionId) {
              const entry = moduleForFunctionId(functionId);
              if (entry) await server.ssrLoadModule(moduleDevUrl(entry));
            }
            // Dispatch through a module evaluated in the SSR environment so
            // the handler shares the registry instance with the app modules.
            const handler = await server.ssrLoadModule(HANDLER_ID);
            const response: Response = await handler.handleServerFunctionRequest(
              webRequestFromNode(req),
            );
            await sendWebResponse(res, response);
          })().catch((error) => {
            if (error instanceof Error) server.ssrFixStacktrace(error);
            next(error);
          });
        });
      },
    });
  }

  return [
    {
      name: 'solid:server-functions/setup',
      enforce: 'pre',
      configResolved(config) {
        env = config.mode !== 'production' ? 'development' : 'production';
        root = config.root;
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
              `[vite-plugin-solid] serverFunctions.configure does not exist: ${options.configure}`,
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
        const mode = opts?.ssr ? 'server' : 'client';
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
    {
      name: 'solid:server-functions/compiler',
      enforce: 'pre',
      async transform(code, fileId, opts) {
        const mode = opts?.ssr ? 'server' : 'client';
        const [id] = fileId.split('?');
        if (!filter(id)) {
          return null;
        }

        // Fast path: the directive has to appear literally, so anything
        // without the substring can skip the native parse entirely.
        if (!code.includes(directive)) {
          return null;
        }

        const result = await compile(id!, code, {
          ...(mode === 'server' ? serverOptions : clientOptions),
          mode,
          env,
          root,
        });

        if (result.valid) {
          const preloader = preload[mode];
          if (preloader) {
            preloader.defer();
          }
          invalidateModules(
            currentServer,
            mergeManifestRecord(manifest.server, new Set([id!])),
            manifestId,
          );

          return {
            // Appended (not prepended) so the source map for the compiled
            // module stays valid; imports hoist and the endpoint is only
            // read at call time, never during module evaluation.
            code: (result.code || '') + endpointConfigureSnippet(mode),
            map: result.map,
          };
        }
        return null;
      },
    },
    ...turnkeyPlugins,
  ];
}
