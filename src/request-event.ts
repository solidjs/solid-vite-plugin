// Start mode's per-request render inputs, declared on @solidjs/web's request
// event. The generated handler reads both after the middleware chain ran
// down to the page render; the generated entries pass the nonce to
// renderToStream.
import type { CSPNonce, RequestEvent, ResponseStub } from '@solidjs/web';
import type { Component } from 'solid-js';

declare module '@solidjs/web' {
  interface RequestEvent {
    /**
     * Start mode: the CSP nonce for this request's page render. It reaches
     * the runtime's scripts, preloads and styles (generated entries pass
     * `event.nonce` to `renderToStream`; an authored entry forwards the
     * `context.nonce` the handler passes it), the injected client-entry
     * tag, the post-flush redirect fallback, the dev head tags and a
     * `<meta property="csp-nonce">` for Vite's client code.
     * `handleRequest(request, { nonce })` overrides it. Set it in
     * `start.middleware` before calling `next()` — the render runs inside it.
     */
    nonce?: CSPNonce | null;
    /**
     * Start mode: how the generated handler turns this request's page render
     * into a body — `'stream'` (flush the shell, stream boundaries behind
     * it) or `'async'` (one settled document, for clients that never run
     * JavaScript). Overrides `start.renderMode`;
     * `handleRequest(request, { renderMode })` overrides it. Set it in
     * `start.middleware` before calling `next()`.
     */
    renderMode?: 'stream' | 'async';
  }
}

/**
 * The request event in start mode. Every event the generated handler creates
 * carries `response`, the mutable response head: status and headers written
 * to it before the head is sent land on the `Response` the handler returns,
 * whether that is a page, a server-function call or a middleware's own
 * `Response`. `nativeEvent` is the platform's raw request object when the
 * server entry passed one (the plugin's dev and preview middlewares and the
 * emitted `node.js` pass the Node `IncomingMessage`), so narrow it before use.
 * `@solidjs/web` types `getRequestEvent()` as the base `RequestEvent`, which
 * has neither field; cast its result to this type in start-mode code.
 */
export type StartRequestEvent = RequestEvent & {
  response: ResponseStub;
  nativeEvent?: unknown;
};

/**
 * A `start.middleware` function: receives the request event (the request is
 * `event.request`) and `next`, and returns the `Response`. `next()` takes no
 * arguments — assign `event.request` before calling it to hand a different
 * request downstream. Per-request render inputs (`event.nonce`,
 * `event.renderMode`) also go on the event before `next()`: the page render
 * runs inside it.
 */
export type StartMiddleware = (
  event: StartRequestEvent,
  next: () => Promise<Response>,
) => Response | Promise<Response>;

/**
 * A `start.serverRenderSetup` module's default export: runs before every
 * page render with the request event (middleware `locals` included) and the
 * app component. Return a component to render it in the app's place inside
 * the Document, or nothing to keep `<App />`.
 */
export type StartServerRenderSetup = (
  event: StartRequestEvent,
  App: Component,
) => Component | void | Promise<Component | void>;

/**
 * The `context` an authored server entry's `render(request, context)`
 * receives: the resolved client entry URL, this request's CSP nonce when
 * one is set (forward it to `renderToStream`), and any fields the host
 * passed as `handleRequest`'s `context` option.
 */
export type StartServerRenderContext = {
  clientEntry: string;
  nonce?: CSPNonce | null;
  [key: string]: unknown;
};
