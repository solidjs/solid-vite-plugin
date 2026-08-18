// Fetch-style middleware chain for the middleware/preview e2e modes
// (SSR_MIDDLEWARE=1 wires it through `start.middleware` in vite.config.ts).
// Server-only: only the generated handler imports it. Exercises the whole
// contract:
// - runs inside the request-event scope: getRequestEvent() answers, locals
//   decoration is visible to the page render and to server functions,
// - composition order (first → second → dispatch, unwinding in reverse),
// - short-circuiting (/blocked never reaches the render), with a stub
//   cookie set inside the request scope that only the handler edge's
//   commit fold can carry onto the early-return Response,
// - error middleware (try/catch around next() turns a render throw into a
//   controlled 500),
// - the post-next() mutation window: headers set after `await next()` land
//   on the wire even for streamed responses (nothing is sent until the
//   outermost middleware returns),
// - API-style dispatch (the createAPIHandler shape): non-HTML GETs, POSTs
//   with bodies, and no-JS form POSTs must all reach the chain — in dev
//   exactly as in production — while non-page requests the chain does NOT
//   handle fall back to Vite's own pipeline in dev.
import { getRequestEvent } from '@solidjs/web';

type Next = (request?: Request) => Promise<Response>;

// A minimal filesystem-routing/createAPIHandler stand-in: owns /api/* and
// the no-JS form endpoint, passes everything else down the chain.
async function api(request: Request, next: Next): Promise<Response> {
  const { pathname } = new URL(request.url);
  if (request.method === 'GET' && pathname === '/api/info') {
    const event = getRequestEvent()!;
    return Response.json({ user: event.locals.user, order: event.locals.order });
  }
  if (request.method === 'GET' && pathname === '/api/native') {
    // The `options.event` seam: the plugin's dev/preview middlewares (and a
    // Node production entry like server.js) pass the raw Node request as
    // `nativeEvent`, spread into the event at creation — app code reads it
    // back through getRequestEvent(). The e2e asserts a live socket address
    // in dev/prod/preview and an exact synthetic one for a direct
    // handleRequest(request, { event }) call.
    const event = getRequestEvent()! as unknown as {
      nativeEvent?: { socket?: { remoteAddress?: string } };
    };
    return Response.json({
      hasNativeEvent: !!event.nativeEvent,
      remoteAddress: event.nativeEvent?.socket?.remoteAddress ?? null,
    });
  }
  if (request.method === 'GET' && pathname === '/api/request-info') {
    // Node→web bridge surface for test/http-bridge.mjs: echoes the URL the
    // handler actually saw (protocol/host derivation under TLS and HTTP/2)
    // and the wire protocol version off the raw Node request.
    const event = getRequestEvent()! as unknown as {
      nativeEvent?: { httpVersion?: string };
    };
    return Response.json({
      url: request.url,
      httpVersion: event.nativeEvent?.httpVersion ?? null,
    });
  }
  if ((request.method === 'GET' || request.method === 'HEAD') && pathname === '/api/abort-probe') {
    // Bridge surface for test/http-bridge.mjs: a never-ending stream that
    // records, on a process global the in-process test reads back, whether
    // the request's AbortSignal fired (client disconnect propagation) and
    // whether the body stream was cancelled (HEAD short-circuit / reader
    // cleanup).
    const g = globalThis as { __solidBridgeProbe?: { aborts: number; cancels: number } };
    const probe = (g.__solidBridgeProbe ??= { aborts: 0, cancels: 0 });
    const encoder = new TextEncoder();
    let timer: ReturnType<typeof setInterval> | undefined;
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode('tick\n'));
        timer = setInterval(() => controller.enqueue(encoder.encode('tick\n')), 25);
        request.signal.addEventListener('abort', () => {
          probe.aborts++;
          clearInterval(timer);
          try {
            controller.close();
          } catch {
            // already cancelled
          }
        });
      },
      cancel() {
        probe.cancels++;
        clearInterval(timer);
      },
    });
    return new Response(stream, { headers: { 'content-type': 'text/plain' } });
  }
  if (request.method === 'POST' && pathname === '/api/echo') {
    // The request body must arrive intact through the node -> web bridge.
    return Response.json({ method: request.method, echoed: await request.json() });
  }
  if (request.method === 'POST' && pathname === '/form') {
    // The no-JS form pattern: read urlencoded fields, answer with a
    // post-redirect-get.
    const form = await request.formData();
    return new Response(null, {
      status: 303,
      headers: { location: `/?submitted=${encodeURIComponent(String(form.get('name')))}` },
    });
  }
  return next();
}

async function first(request: Request, next: Next): Promise<Response> {
  const event = getRequestEvent()!;
  event.locals.order = ['first'];
  event.locals.user = 'mw-user';
  if (new URL(request.url).pathname === '/blocked') {
    // Early return: this Response never goes through createSSRResponse, so
    // the stub write below only reaches the wire through the handler
    // edge's commitEventResponse fold after the chain unwinds — the e2e
    // asserts the cookie arrives exactly once (fold ran, and only once).
    event.response.headers.append('set-cookie', 'mw-blocked=1; Path=/');
    return new Response('blocked-by-middleware', { status: 403 });
  }
  try {
    const response = await next();
    // Post-next() window: the streamed body has not hit the wire yet, so
    // these must be observable on the response head.
    response.headers.set('x-mw-order', (event.locals.order as string[]).join(','));
    response.headers.set('x-after-next', 'set-after-next');
    return response;
  } catch (error) {
    return new Response(`caught: ${error instanceof Error ? error.message : String(error)}`, {
      status: 500,
      headers: { 'x-mw-caught': '1' },
    });
  }
}

function second(request: Request, next: Next): Promise<Response> {
  (getRequestEvent()!.locals.order as string[]).push('second');
  return next();
}

export default [first, second, api];
