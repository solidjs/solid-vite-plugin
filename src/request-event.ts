// Start mode's per-request render inputs, declared on @solidjs/web's request
// event. The generated handler reads both after the middleware chain ran
// down to the page render; the generated entries pass the nonce to
// renderToStream.
import type { CSPNonce, RequestEvent } from '@solidjs/web';

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
 * A `start.middleware` function: receives the request event (the request is
 * `event.request`) and `next`, and returns the `Response`. `next()` takes no
 * arguments — assign `event.request` before calling it to hand a different
 * request downstream. Per-request render inputs (`event.nonce`,
 * `event.renderMode`) also go on the event before `next()`: the page render
 * runs inside it.
 */
export type StartMiddleware = (
  event: RequestEvent,
  next: () => Promise<Response>,
) => Response | Promise<Response>;
