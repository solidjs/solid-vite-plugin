// Fetch-style middleware chain for the middleware/preview e2e modes
// (SSR_MIDDLEWARE=1 wires it through `ssr.middleware` in vite.config.ts).
// Server-only: only the generated handler imports it. Exercises the whole
// contract:
// - runs inside the request-event scope: getRequestEvent() answers, locals
//   decoration is visible to the page render and to server functions,
// - composition order (first → second → dispatch, unwinding in reverse),
// - short-circuiting (/blocked never reaches the render),
// - error middleware (try/catch around next() turns a render throw into a
//   controlled 500),
// - the post-next() mutation window: headers set after `await next()` land
//   on the wire even for streamed responses (nothing is sent until the
//   outermost middleware returns).
import { getRequestEvent } from '@solidjs/web';

type Next = (request?: Request) => Promise<Response>;

async function first(request: Request, next: Next): Promise<Response> {
  const event = getRequestEvent()!;
  event.locals.order = ['first'];
  event.locals.user = 'mw-user';
  if (new URL(request.url).pathname === '/blocked') {
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

export default [first, second];
