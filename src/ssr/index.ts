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
// - When `serverFunctions` is also enabled, the handler composes the
//   endpoint on every surface; the runnable-dev server-function middleware
//   pre-loads the referenced module, then dispatches through this handler.
// - Every dispatch runs under a stub-backed request event
//   (`createRequestEvent`) with the optional `ssr.middleware` chain fronting
//   it, and page responses go through the runtime's `createSSRResponse`
//   head lifecycle (commit at shell flush, real pre-flush redirects, the
//   script fallback post-flush).
// - `vite preview` serves dist/client statically and dispatches everything
//   else through the built handler — the production path, middleware
//   included, with no server file needed.
import { existsSync } from 'fs';
import path from 'path';
import { pathToFileURL } from 'node:url';
import {
  type DevEnvironment,
  type Plugin,
  type PreviewServer,
  type ViteDevServer,
} from 'vite';
import { isRunnableEnvironment } from '../environment.js';
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
   * @default undefined
   */
  middleware?: string;
  /**
   * Let a host integration own the server environment — build wiring and
   * HTTP serving alike. The plugin skips its turnkey server-build config and
   * stands its dev middlewares down (SSR serving and the server-function
   * endpoint); the generated `virtual:solid-ssr-handler` self-serves
   * instead, inlining dev styles through a virtual module and composing the
   * server-function endpoint, so `handleRequest(request)` is the whole
   * contract in dev exactly as in production. Generated entries and the
   * client manifest are still provided.
   *
   * Often unnecessary: a provider-owned (non-runnable) `ssr` dev environment
   * is detected automatically and the middlewares stand down on their own.
   * Set this when the host also owns the server build, or when its
   * environment uses a different name so detection can't see it. To hand
   * over only the server-function endpoint, use
   * `serverFunctions.devMiddleware: false` instead.
   *
   * @default false
   */
  external?: boolean;
}

// Server-only turnkey request handler; also the server bundle's entry so a
// production server is one import away from `Request -> Response`. Exported
// for the main plugin to thread into the server-function dev middleware,
// which dispatches through it when turnkey SSR is active (one middleware
// chain and one request event across both dispatch paths).
export const SSR_HANDLER_ID = 'virtual:solid-ssr-handler';
const HANDLER_ID = SSR_HANDLER_ID;
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
  /** Absolute path of the user's middleware module, when configured. */
  let middlewarePath: string | null = null;

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
        `    throw new Error('[vite-plugin-solid] ssr.middleware must default-export a function or an array of functions: ' + ${JSON.stringify(middlewarePath)});`,
        `  }`,
        `}`,
        `const runMiddleware = composeMiddleware(middlewares);`,
      );
    } else {
      lines.push(`const runMiddleware = (request, next) => next(request);`);
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
      `function createHtmlChunkTransform(clientEntry, extraHead) {`,
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
        `  if (new URL(request.url).pathname === endpoint) {`,
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
    lines.push(
      isBuild
        ? `  const clientEntry = options.clientEntry || resolveClientEntry();`
        : `  const clientEntry = options.clientEntry || ${JSON.stringify(devClientEntryUrl())};`,
      `  let result = entry.render(request, { clientEntry, ...options.context });`,
      // renderToStream results are thenables whose then() waits for the
      // *complete* render — check for pipe first so streaming survives, and
      // only await plain promises (async render functions).
      `  if (result && typeof result.pipe !== 'function' && typeof result.then === 'function') {`,
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
      `    transformChunk: createHtmlChunkTransform(clientEntry, options.devHead),`,
      `  });`,
      `}`,
      ``,
      `export async function handleRequest(request, options = {}) {`,
      `  const event = createRequestEvent(request);`,
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
        middlewarePath = options.middleware
          ? path.resolve(root, normalizeUserPath(root, options.middleware, 'middleware'))
          : null;
        if (env.isPreview) {
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
            (externalServer || !isRunnableEnvironment(this.environment));
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
      configurePreviewServer(server: PreviewServer) {
        // `vite build && vite preview` runs the production artifact as-is:
        // Vite's preview statics serve dist/client (see the config hook) and
        // everything else — pages, the server-function endpoint, middleware
        // included — dispatches through the built handler, exactly like a
        // deployed server. Hosts owning the server build (`ssr.external`)
        // preview through their own runner instead.
        if (externalServer) return;
        return () => {
          let handlerPromise: Promise<{
            handleRequest: (request: Request) => Promise<Response>;
          }> | null = null;
          server.middlewares.use((req, res, next) => {
            (async () => {
              handlerPromise ??= import(
                pathToFileURL(path.resolve(root, 'dist/server/server.js')).href
              );
              const handler = await handlerPromise;
              const response = await handler.handleRequest(webRequestFromNode(req));
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
          if (externalServer || (ssrEnvironment && !isRunnableEnvironment(ssrEnvironment))) {
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
