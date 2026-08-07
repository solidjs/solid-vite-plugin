declare module "virtual:solid-manifest" {
  import type { ViteManifest } from "vite-plugin-solid";
  const manifest: ViteManifest;
  export default manifest;
}

// Side-effect module: importing it loads every module containing server
// functions so their registrations exist before requests are dispatched.
declare module "virtual:solid-server-function-manifest" {}

// Server-only turnkey handler (SSR builds). Importing it registers every
// server function (via the manifest above), scopes each request with
// provideRequestEvent, and configures the endpoint; mount
// `handleServerFunctionRequest` on the endpoint in your server.
declare module "virtual:solid-server-function-handler" {
  /** The resolved endpoint path (plugin `endpoint` option joined with Vite `base`). */
  export const endpoint: string;
  export function handleServerFunctionRequest(
    request: Request,
    options?: Record<string, unknown>,
  ): Promise<Response>;
}

// Server-only turnkey request handler (the `start` option). It is the SSR
// build's entry, so a production server imports it from the built bundle
// (e.g. `./dist/server/server.js`) rather than by this id; importing the
// id directly also works from custom server code in SSR builds.
// Streams the rendered app for a web Request, scopes it with
// provideRequestEvent, resolves hashed client assets through the build
// manifest, and — when `serverFunctions` is enabled — serves the
// server-function endpoint ahead of SSR.
declare module "virtual:solid-ssr-handler" {
  export function handleRequest(
    request: Request,
    options?: {
      /** Override the resolved client entry URL injected into the document. */
      clientEntry?: string;
      /** Extra fields merged into the `context` passed to the entry's `render`. */
      context?: Record<string, unknown>;
      /** Status/headers for the HTML response. */
      responseInit?: ResponseInit;
      /** Options forwarded to the server-function handler for endpoint requests. */
      serverFunctions?: Record<string, unknown>;
    },
  ): Promise<Response>;
}
