// Per-request app setup (`start.setup`): the seam for routers that must
// prepare an app instance before SSR begins — TanStack-style
// `await router.load()` — receiving the shared request event (middleware
// locals included) and returning the component to render in the app's
// place. This fake awaits real async work, proves ordering (the middleware
// chain already decorated `locals.user`), and counts invocations so the
// harness can assert the hook runs per request, not once per module.
//
// It also plays the integration's half of the no-JS server-function
// convention (solidjs/solid#3239): a form posted without the client runtime
// redirects back here with its outcome riding an encrypted one-shot flash
// cookie. The hook decodes it — under the deployment secret the plugin
// injects into the handler graph — surfaces it as a marker for the e2e, and
// clears the cookie so the next render reads "no flash".
import type { Component } from 'solid-js';
import type { RequestEvent } from '@solidjs/web';
import {
  clearFlashCookie,
  decodeFlashCookie,
  hasFlashCookie,
} from '@solidjs/web/server-functions/server';

let invocations = 0;

export default async function setup(event: RequestEvent, App: Component) {
  // Simulates the router's pre-render load; must complete before the shell
  // streams, so the marker below always lands in the first chunk.
  await new Promise((resolve) => setTimeout(resolve, 10));
  const pathname = new URL(event.request.url).pathname;
  // Containment probe: a setup failure escapes the chain (src/middleware.ts
  // lets this path past its error middleware), so the handler contains it.
  // Thrown before the count, which stays one per rendered request.
  if (pathname === '/setup-throw') throw new Error('token=setup-throw-secret');
  const seq = ++invocations;
  const user = String((event.locals as Record<string, unknown>).user ?? 'anonymous');
  const cookieHeader = event.request.headers.get('cookie');
  // One-shot: cleared whether or not it decodes (a tampered or stale cookie
  // reads as "no flash" and is disposed of the same way).
  if (hasFlashCookie(cookieHeader)) {
    event.response.headers.append('set-cookie', clearFlashCookie());
  }
  const flash = await decodeFlashCookie(cookieHeader);
  let flashMarker = '';
  if (flash) {
    // A urlencoded post arrives as URLSearchParams, a multipart one as
    // FormData; either way the submitted field must survive the cookie.
    const input = flash.input[0];
    const submitted =
      input instanceof FormData || input instanceof URLSearchParams
        ? String(input.get('name'))
        : `unexpected-input(${input?.constructor?.name ?? typeof input})`;
    flashMarker = `flash:${flash.url}:${String(flash.result)}:${submitted}`;
  }
  return () => (
    <>
      <p id="setup-marker">{`setup:${pathname}:${user}:${seq}`}</p>
      {flashMarker ? <p id="flash-marker">{flashMarker}</p> : null}
      <App />
    </>
  );
}
