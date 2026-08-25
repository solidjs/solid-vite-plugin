// Server-posture regression test (the `server` project of the
// VITEST_PROJECTS workspace in vite.config.ts): a vitest project that
// explicitly opts into `environment: 'node'` must get the SERVER posture
// end to end — server export conditions (isServer true, the real server
// build of @solidjs/web), ssr codegen — while the sibling jsdom project in
// the same workspace keeps the client posture (src/posture.test.tsx).
// Before the opt-out, the client posture applied pipeline-wide and
// server-runtime unit suites (session/server-function code paths) needed
// ~20 lines of inline/alias workarounds to reach the server build.
import { expect, it } from 'vitest';
import { getRequestEvent, isServer } from '@solidjs/web';
import { provideRequestEvent } from '@solidjs/web/storage';

function Item() {
  return <p>server-posture</p>;
}

it('resolves the server build under an explicit node environment', () => {
  expect(isServer).toBe(true);
});

it('compiles with server codegen (ssr strings, not DOM templates)', () => {
  const compiled = String(Item);
  expect(compiled).toMatch(/ssr/);
  expect(compiled).not.toMatch(/getNextElement|cloneNode/);
});

it('request-event storage flows through one framework instance', () => {
  // The template's session suite lives on this: getRequestEvent() must see
  // the event provideRequestEvent installed, which only works when the
  // main entry and /storage resolve into the same server build (the old
  // workaround aliased both by hand to keep the instances from splitting).
  const event = { request: new Request('http://localhost/session-test') } as any;
  const seen = provideRequestEvent(event, () => getRequestEvent());
  expect(seen).toBe(event);
});
