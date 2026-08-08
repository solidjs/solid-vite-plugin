// Per-request app setup (`start.setup`): the seam for routers that must
// prepare an app instance before SSR begins — TanStack-style
// `await router.load()` — receiving the shared request event (middleware
// locals included) and returning the component to render in the app's
// place. This fake awaits real async work, proves ordering (the middleware
// chain already decorated `locals.user`), and counts invocations so the
// harness can assert the hook runs per request, not once per module.
import type { Component } from 'solid-js';
import type { RequestEvent } from '@solidjs/web';

let invocations = 0;

export default async function setup(event: RequestEvent, App: Component) {
  // Simulates the router's pre-render load; must complete before the shell
  // streams, so the marker below always lands in the first chunk.
  await new Promise((resolve) => setTimeout(resolve, 10));
  const seq = ++invocations;
  const pathname = new URL(event.request.url).pathname;
  const user = String((event.locals as Record<string, unknown>).user ?? 'anonymous');
  return () => (
    <>
      <p id="setup-marker">{`setup:${pathname}:${user}:${seq}`}</p>
      <App />
    </>
  );
}
