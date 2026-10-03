declare module "virtual:solid-manifest" {
  import type { ViteManifest } from "@solidjs/vite-plugin";
  const manifest: ViteManifest;
  export default manifest;
}

// Side-effect module: importing it loads every module containing server
// functions so their registrations exist before requests are dispatched.
declare module "virtual:solid-server-function-manifest" {}

// Server-only handler (SSR builds). Importing it registers every
// server function (via the manifest above), scopes each request with
// provideRequestEvent, and configures the endpoint; mount
// `handleServerFunctionRequest` on the endpoint in your server.
declare module "virtual:solid-server-function-handler" {
  /** The resolved endpoint path (plugin `endpoint` option joined with Vite `base`). */
  export const endpoint: string;
  export function handleServerFunctionRequest(
    request: Request,
    options?: {
      /**
       * Extra fields spread into the request event at creation — the public
       * wrapper→event extension seam, same as the SSR handler's
       * `handleRequest`. Conventionally `nativeEvent` carries the platform's
       * raw request object (the plugin's dev middleware and a Node server
       * entry pass the Node `IncomingMessage`); read it back with
       * `getRequestEvent()`.
       */
      event?: Record<string, unknown>;
    } & Record<string, unknown>,
  ): Promise<Response>;
}

// Server-only start-mode request handler (the `start` option). It is the SSR
// build's entry, so a production server imports it from the built bundle
// (e.g. `./dist/server/server.js`) rather than by this id; importing the
// id directly also works from custom server code in SSR builds.
// Streams the rendered app for a web Request, scopes it with
// provideRequestEvent, resolves hashed client assets through the build
// manifest, and — when `serverFunctions` is enabled — serves the
// server-function endpoint ahead of SSR.
declare module "virtual:solid-ssr-handler" {
  import type { CSPNonce } from "@solidjs/web";

  export function handleRequest(
    request: Request,
    options?: {
      /** Override the resolved client entry URL injected into the document. */
      clientEntry?: string;
      /** Extra fields merged into the `context` passed to the entry's `render`. */
      context?: Record<string, unknown>;
      /** Status/headers for the HTML response. */
      responseInit?: ResponseInit;
      /**
       * Per-call CSP nonce, overriding `start.nonce`, in `@solidjs/web`'s
       * `CSPNonce` shape. A string applies to scripts and styles; a
       * `{ script, style }` pair routes each destination, with `false`
       * leaving it un-nonced. An empty value (`undefined`, `null` or `''`)
       * leaves the nonce to `start.nonce`. It reaches the generated entry's
       * `renderToStream` (hydration, streamed data and swap scripts,
       * `modulepreload` links), the injected client-entry tag and the
       * post-flush redirect fallback; the entry's `render` receives it as
       * `context.nonce`, in place of a `nonce` passed in `context`, which
       * reaches the entry unchanged when no nonce resolves.
       */
      nonce?: CSPNonce | null;
      /**
       * Per-call render mode, overriding `start.renderMode` (static value or
       * per-request module alike). `'stream'` flushes the document shell
       * with `<Loading>` fallbacks and streams boundary content behind it;
       * `'async'` awaits the render until every boundary settled and sends
       * one complete document — no fallbacks, no swap scripts, hydration
       * data intact — for clients that never run JavaScript. A mid-render
       * `Location` becomes a real 3xx under `'async'`.
       */
      renderMode?: 'stream' | 'async';
      /**
       * Extra fields spread into the request event at creation — the public
       * wrapper→event extension seam. Conventionally `nativeEvent` carries
       * the platform's raw request object; the plugin's dev/preview
       * middlewares (and, by convention, a custom Node server entry) pass
       * the Node `IncomingMessage` here, so `getRequestEvent().nativeEvent`
       * answers the same on every surface. Read it back anywhere inside the
       * request scope with `getRequestEvent()`.
       */
      event?: Record<string, unknown>;
      /** Options forwarded to the server-function handler for endpoint requests. */
      serverFunctions?: Record<string, unknown>;
    },
  ): Promise<Response>;

  /** Fetchable entry for runtimes and deployment integrations that use the web-standard convention. */
  const handler: {
    fetch(request: Request): Promise<Response>;
  };
  export default handler;
}
