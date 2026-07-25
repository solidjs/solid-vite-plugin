// Turnkey SSR for plain Vite apps: `solid({ ssr: {...} })` (the object form
// of the existing `ssr` option) adds a serving layer on top of the SSR
// transforms so no hand-rolled entries or dev server are needed.
//
// - Dev: runnable SSR environments are served by a Vite middleware. Provider-
//   owned environments serve through `virtual:solid-ssr-handler` instead.
//   Both paths inject the Vite client, dev style patch, and entry CSS as
//   `<style data-vite-dev-id>` tags before the body can paint.
// - Prod: the plugin configures a full-app build (client + server bundles
//   via the Vite 6+ environments/builder API — a single `vite build` builds
//   both) whose server entry is `virtual:solid-ssr-handler`: an
//   adapter-agnostic `handleRequest(Request) => Promise<Response>` that
//   scopes each request with `provideRequestEvent`, streams the render, and
//   resolves hashed client assets through `virtual:solid-manifest`.
// - Entries are conventional with escape hatches: `src/entry-server.*` /
//   `src/entry-client.*` are used when present (or set explicitly); when
//   absent, default entries are generated from a single root component
//   (`ssr.app`, defaulting to `src/App.*`) wrapped in a document shell
//   (`ssr.document`, defaulting to `src/Document.*`, else a built-in one).
// - When `serverFunctions` is also enabled, the production handler and any
//   provider-owned dev handler compose it. Runnable dev environments keep the
//   earlier server-function middleware.
import { existsSync } from 'fs';
import path from 'path';
import {
  isRunnableDevEnvironment,
  type DevEnvironment,
  type Plugin,
  type ViteDevServer,
} from 'vite';
import {
  collectDevStyles,
  collectDevStyleSources,
  devStylePatch,
  renderDevStyleTag,
} from '../dev-manifest.js';
import { joinBase, sendWebResponse, webRequestFromNode } from '../http.js';

export interface SsrOptions {
  /**
   * Root component module for generated entries (the zero-config path).
   * Resolved relative to the Vite root.
   *
   * @default "src/App.{tsx,jsx,ts,js}" (also probes lowercase "src/app.*")
   */
  app?: string;
  /**
   * Server entry module. Must export `render(request?, context?)` returning
   * a `renderToStream` result, an HTML string, or a `Response`.
   * `context.clientEntry` carries the resolved client entry URL.
   *
   * @default "src/entry-server.{tsx,jsx,ts,js,mjs}" when present, else a
   * generated entry rendering `<Document><App /></Document>`
   */
  entryServer?: string;
  /**
   * Client (hydration) entry module.
   *
   * @default "src/entry-client.{tsx,jsx,ts,js,mjs}" when present, else a
   * generated entry hydrating `<Document><App /></Document>`
   */
  entryClient?: string;
  /**
   * Document shell component wrapping the app in generated entries. Receives
   * `props.children` and must render the full `<html>` document including
   * `<HydrationScript />`. Only used when the entries are generated.
   *
   * @default "src/Document.{tsx,jsx}" when present, else a built-in shell
   */
  document?: string;
  /**
   * Let an integration own the server build and HTTP serving. Turnkey still
   * provides its generated entries, request handler, and client manifest.
   *
   * Non-runnable development environments are detected automatically.
   *
   * @default false
   */
  external?: boolean;
}

// Server-only turnkey request handler; also the server bundle's entry so a
// production server is one import away from `Request -> Response`.
const HANDLER_ID = 'virtual:solid-ssr-handler';
const DEV_STYLES_ID = 'virtual:solid-ssr-dev-styles';
const RESOLVED_DEV_STYLES_ID = '\0' + DEV_STYLES_ID;
// Generated default entries / document shell. The `.tsx` suffix routes them
// through the plugin's normal JSX transform (per-environment SSR/DOM
// compile), exactly like user-authored entry files.
const ENTRY_SERVER_ID = 'virtual:solid-ssr-entry-server.tsx';
const ENTRY_CLIENT_ID = 'virtual:solid-ssr-entry-client.tsx';
const DOCUMENT_ID = 'virtual:solid-ssr-document.tsx';

const MANIFEST_ID = 'virtual:solid-manifest';
const SERVER_FUNCTION_HANDLER_ID = 'virtual:solid-server-function-handler';
const STORAGE_SOURCE = '@solidjs/web/storage';

const ENTRY_EXTENSIONS = ['.tsx', '.jsx', '.ts', '.js', '.mjs'];
const APP_EXTENSIONS = ['.tsx', '.jsx', '.ts', '.js'];
const DOCUMENT_EXTENSIONS = ['.tsx', '.jsx'];

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
    throw new Error(`[vite-plugin-solid] ssr.${option} does not exist: ${spec}`);
  }
  const relative = path.relative(root, absolute).split(path.sep).join('/');
  if (relative.startsWith('..')) {
    throw new Error(`[vite-plugin-solid] ssr.${option} must live inside the Vite root: ${spec}`);
  }
  return relative;
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

function resolveEntries(root: string, options: SsrOptions): ResolvedEntries {
  const explicitServer = options.entryServer
    ? normalizeUserPath(root, options.entryServer, 'entryServer')
    : null;
  const explicitClient = options.entryClient
    ? normalizeUserPath(root, options.entryClient, 'entryClient')
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
      `[vite-plugin-solid] found ${found} but no ${missing}; entry files come in pairs. ` +
        `Provide both (src/entry-server.* and src/entry-client.*, or the ssr.entryServer / ` +
        `ssr.entryClient options) or neither (to generate both from ssr.app).`,
    );
  }

  const app = options.app
    ? normalizeUserPath(root, options.app, 'app')
    : (probe(root, 'src/App', APP_EXTENSIONS) ?? probe(root, 'src/app', APP_EXTENSIONS));
  if (!app) {
    throw new Error(
      `[vite-plugin-solid] turnkey SSR needs an app root: add src/App.tsx (or set ssr.app), ` +
        `or provide src/entry-server.* and src/entry-client.* entries.`,
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

export function ssrServe(
  options: SsrOptions,
  internal: { serverFunctions?: boolean; serverComponents?: boolean } = {},
): Plugin[] {
  // Server components (`serverFunctions: { components: true }`): generated
  // entries additionally emit the document-SSR wiring — the render plugin +
  // direct-call transform server-side, the bootstrap script in <head>, and
  // the client-side installServerComponents() call. Authored entries carry
  // those pieces themselves (the endpoint response transform is installed by
  // the server-function handler module either way). Everything is gated
  // codegen: with the option off, none of these imports exist anywhere.
  const serverComponents = !!internal.serverComponents;
  const externalServer = !!options.external;
  let root = process.cwd();
  let base = '/';
  let isBuild = false;
  let entries: ResolvedEntries | undefined;

  function requireEntries(): ResolvedEntries {
    // config() always runs before resolveId/load/configureServer.
    if (!entries) throw new Error('[vite-plugin-solid] SSR entries not resolved yet');
    return entries;
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
    const { generated, app, document, entryServer } = requireEntries();
    return generated ? [app!, ...(document ? [document] : [])] : [path.resolve(root, entryServer)];
  }

  async function devStylesModuleCode(
    environment: DevEnvironment,
    watchFile: (file: string) => void,
  ): Promise<string> {
    const styles = await collectDevStyleSources(environment, styleRoots(), watchFile);
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

  function generatedEntryServerCode(): string {
    const { app } = requireEntries();
    return [
      `import { renderToStream } from '@solidjs/web';`,
      ...(serverComponents
        ? [
            `import { configureServerFunctionsServer } from '@solidjs/web/server-functions';`,
            `import { frameTransformDirectResult, ServerComponentPlugin } from '@solidjs/web/frames';`,
          ]
        : []),
      `import manifest from ${JSON.stringify(MANIFEST_ID)};`,
      `import Document from ${JSON.stringify(documentSpec())};`,
      `import App from ${JSON.stringify(app)};`,
      ``,
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
      `export function render(request, context) {`,
      `  return renderToStream(() => (`,
      `    <Document>`,
      `      <App />`,
      `    </Document>`,
      `  ), { manifest${serverComponents ? ', plugins: [ServerComponentPlugin]' : ''} });`,
      `}`,
    ].join('\n');
  }

  function generatedEntryClientCode(): string {
    const { app } = requireEntries();
    return [
      `import { hydrate } from '@solidjs/web';`,
      ...(serverComponents
        ? [`import { installServerComponents } from '@solidjs/web/frames';`]
        : []),
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
      `  <Document>`,
      `    <App />`,
      `  </Document>`,
      `), document);`,
    ].join('\n');
  }

  // Built-in document shell: minimal, hydration-ready. The client entry
  // script is injected into <head> by the handler (not rendered here) so its
  // URL never has to survive hydration or a manifest lookup client-side.
  const documentShellCode = [
    `import { HydrationScript } from '@solidjs/web';`,
    ``,
    `export default function Document(props) {`,
    `  return (`,
    `    <html lang="en">`,
    `      <head>`,
    `        <meta charset="utf-8" />`,
    `        <meta name="viewport" content="width=device-width, initial-scale=1.0" />`,
    `        <HydrationScript />`,
    `      </head>`,
    `      <body>{props.children}</body>`,
    `    </html>`,
    `  );`,
    `}`,
  ].join('\n');

  // The handler module: dev and prod share the render/response plumbing;
  // they differ in how the client entry URL is known (baked dev URL vs a
  // manifest scan), what gets injected into <head> (Vite client + style
  // patch in dev), and server-function composition (production and external
  // dev; runnable dev environments use the server-function middleware).
  function handlerModuleCode(externalDev: boolean): string {
    const { generated, entryClient } = requireEntries();
    const composeServerFunctions = (isBuild || externalDev) && internal.serverFunctions;
    // Generated entries own the whole document wiring, so the handler also
    // injects the server-component bootstrap (the per-function-id
    // placeholder registry the render plugin references; must be inline at
    // the TOP of <head>, before the hydration data script streams in — see
    // the transform below). Authored entries inject it themselves.
    const injectComponentBootstrap = generated && serverComponents;

    const lines = [
      `import { provideRequestEvent } from ${JSON.stringify(STORAGE_SOURCE)};`,
      `import * as entry from ${JSON.stringify(entryServerSpec())};`,
      ...(externalDev ? [`import DEV_STYLES_HEAD from ${JSON.stringify(DEV_STYLES_ID)};`] : []),
      ...(composeServerFunctions
        ? [
            `import { handleServerFunctionRequest, endpoint } from ${JSON.stringify(SERVER_FUNCTION_HANDLER_ID)};`,
          ]
        : []),
      ...(injectComponentBootstrap
        ? [`import { SERVER_COMPONENT_BOOTSTRAP } from '@solidjs/web/frames';`]
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

    lines.push(
      ``,
      `function createHtmlChunkTransform(clientEntry, extraHead) {`,
      `  let injected = false;`,
      ...(injectComponentBootstrap ? [`  let bootstrapped = false;`] : []),
      `  return (chunk) => {`,
    );
    if (injectComponentBootstrap) {
      // The bootstrap has to precede the hydration data script, not merely be
      // present in <head>: the render plugin serializes a server component's
      // placeholder as `self._$SC.r(id)`, so a document whose payload carries
      // one throws on that reference if the registry is not defined yet.
      // <HydrationScript /> sits inside <head>, so anchoring on `</head>`
      // always lands after it — the opening tag is the only anchor that is
      // reliably before it.
      lines.push(
        `    if (!bootstrapped) {`,
        `      const headOpen = /<head(\\s[^>]*)?>/.exec(chunk);`,
        `      if (headOpen) {`,
        `        bootstrapped = true;`,
        `        const at = headOpen.index + headOpen[0].length;`,
        `        chunk =`,
        `          chunk.slice(0, at) +`,
        `          '<script>' + SERVER_COMPONENT_BOOTSTRAP + '</' + 'script>' +`,
        `          chunk.slice(at);`,
        `      }`,
        `    }`,
      );
    }
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
    if (generated) {
      headParts.push(
        `(clientEntry ? '<script type="module" src="' + clientEntry + '" async></' + 'script>' : '')`,
      );
    }
    if (headParts.length) {
      lines.push(`      chunk = chunk.replace('</head>', ${headParts.join(' + ')} + '</head>');`);
    }
    lines.push(`    }`, `    return chunk;`, `  };`, `}`);

    lines.push(
      ``,
      `function htmlResponse(result, clientEntry, extraHead, init) {`,
      `  const transform = createHtmlChunkTransform(clientEntry, extraHead);`,
      `  const headers = new Headers(init && init.headers);`,
      `  if (!headers.has('content-type')) headers.set('content-type', 'text/html; charset=utf-8');`,
      `  const status = (init && init.status) || 200;`,
      `  if (typeof result === 'string') {`,
      `    return new Response('<!DOCTYPE html>' + transform(result), { status, headers });`,
      `  }`,
      `  const encoder = new TextEncoder();`,
      `  const stream = new ReadableStream({`,
      `    start(controller) {`,
      `      controller.enqueue(encoder.encode('<!DOCTYPE html>'));`,
      `      result.pipe({`,
      `        write(chunk) {`,
      `          controller.enqueue(encoder.encode(transform(chunk)));`,
      `        },`,
      `        end() {`,
      `          controller.close();`,
      `        },`,
      `      });`,
      `    },`,
      `  });`,
      `  return new Response(stream, { status, headers });`,
      `}`,
      ``,
      `export async function handleRequest(request, options = {}) {`,
    );
    if (composeServerFunctions) {
      lines.push(
        `  if (new URL(request.url).pathname === endpoint) {`,
        `    return handleServerFunctionRequest(request, options.serverFunctions);`,
        `  }`,
      );
    }
    lines.push(
      isBuild
        ? `  const clientEntry = options.clientEntry || resolveClientEntry();`
        : `  const clientEntry = options.clientEntry || ${JSON.stringify(devClientEntryUrl())};`,
      `  return provideRequestEvent({ request, locals: {} }, async () => {`,
      `    let result = entry.render(request, { clientEntry, ...options.context });`,
      // renderToStream results are thenables whose then() waits for the
      // *complete* render — check for pipe first so streaming survives, and
      // only await plain promises (async render functions).
      `    if (result && typeof result.pipe !== 'function' && typeof result.then === 'function') {`,
      `      result = await result;`,
      `    }`,
      `    if (result instanceof Response) return result;`,
      `    return htmlResponse(result, clientEntry, options.devHead, options.responseInit);`,
      `  });`,
      `}`,
    );

    return lines.join('\n');
  }

  return [
    {
      name: 'solid:ssr/setup',
      enforce: 'pre',
      config(userConfig, env) {
        root = path.resolve(userConfig.root || process.cwd());
        entries = resolveEntries(root, options);
        const build = env.command === 'build';
        const clientInput = entries.generated
          ? ENTRY_CLIENT_ID
          : path.resolve(root, entries.entryClient);
        // Real files only — the dep scanner can't crawl virtual modules.
        const scanEntries = entries.generated
          ? [entries.app!, ...(entries.document ? [entries.document] : [])]
          : [path.resolve(root, entries.entryClient)];
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
                      build: {
                        outDir: 'dist/server',
                        rollupOptions: { input: { server: HANDLER_ID } },
                      },
                    },
                  },
                  // Presence of `builder` makes a plain `vite build` build the
                  // whole app (all environments: client then ssr) on Vite 6+.
                  // A classic `vite build --ssr` invocation must stay a
                  // single-environment build, so it doesn't get the flag.
                  ...(env.isSsrBuild ? {} : { builder: {} }),
                }
            : {
                optimizeDeps: { entries: scanEntries },
              }),
        };
      },
      configResolved(config) {
        root = config.root;
        base = config.base;
        isBuild = config.command === 'build';
      },
      resolveId(source) {
        if (source === HANDLER_ID) {
          return { id: HANDLER_ID, moduleSideEffects: true };
        }
        if (source === DEV_STYLES_ID) {
          return { id: RESOLVED_DEV_STYLES_ID, moduleSideEffects: true };
        }
        if (source === ENTRY_SERVER_ID || source === ENTRY_CLIENT_ID || source === DOCUMENT_ID) {
          return { id: source, moduleSideEffects: source === ENTRY_CLIENT_ID };
        }
        return null;
      },
      async load(id, opts) {
        if (id === HANDLER_ID) {
          if (!opts?.ssr) {
            this.error(`${HANDLER_ID} is server-only; import it from server code (SSR build).`);
          }
          const externalDev =
            !isBuild &&
            this.environment.mode === 'dev' &&
            (externalServer || !isRunnableDevEnvironment(this.environment));
          return handlerModuleCode(externalDev);
        }
        if (id === RESOLVED_DEV_STYLES_ID) {
          if (!opts?.ssr || this.environment.mode !== 'dev') {
            this.error(`${DEV_STYLES_ID} is only available to the development server handler.`);
          }
          return devStylesModuleCode(this.environment, (file) => this.addWatchFile(file));
        }
        if (id === ENTRY_SERVER_ID) return generatedEntryServerCode();
        if (id === ENTRY_CLIENT_ID) return generatedEntryClientCode();
        if (id === DOCUMENT_ID) return documentShellCode;
        return null;
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
          if (externalServer || (ssrEnvironment && !isRunnableDevEnvironment(ssrEnvironment))) {
            return;
          }
          server.middlewares.use((req, res, next) => {
            if (req.method !== 'GET') return next();
            const accept = req.headers.accept || '';
            if (!accept.includes('text/html')) return next();
            const url = new URL(req.url || '/', 'http://localhost');
            if (url.pathname.startsWith('/@')) return next();
            (async () => {
              // Loaded through the SSR environment so the app, the request
              // event storage, and the handler share one module registry.
              const handler = await server.ssrLoadModule(HANDLER_ID);
              const styles = await collectDevStyles(server, styleRoots());
              const devHead = styles.map(renderDevStyleTag).join('');
              const response: Response = await handler.handleRequest(webRequestFromNode(req), {
                devHead,
              });
              await sendWebResponse(res, response);
            })().catch((error) => {
              if (error instanceof Error) server.ssrFixStacktrace(error);
              // Vite's error middleware renders the overlay-enabled 500 page.
              next(error);
            });
          });
        };
      },
    },
  ];
}
