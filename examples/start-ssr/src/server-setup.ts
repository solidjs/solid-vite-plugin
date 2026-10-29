// `start.serverSetup` (SSR_SERVER_SETUP=1, middleware mode): the
// module the plugin awaits to completion before anything else in the server
// graph loads. That is the seam an APM's OpenTelemetry setup needs
// (`Sentry.init()` must run before the modules it patches are loaded). This fake proves the
// contract without an APM:
// - it evaluates FIRST: nothing from the app graph has run yet, so the
//   ordering register it creates is empty (middleware.ts appends to it at
//   its own module top level, which cannot happen before this line),
// - it is awaited to COMPLETION: real async work here (a timer) finishes
//   before the handler graph is even imported, so middleware.ts reads
//   `done` at its top level and finds it true. A static
//   `import './server-setup'` would fail this: ESM hoists static imports
//   and evaluates them in dependency order, so the handler's `@solidjs/web`
//   import graph would run before this module's body.
// - it counts evaluations: once per server process (dev and prod), not once
//   per request.
// - it records whether node:http was already loaded (node mode asserts not, #418).
declare global {
  // eslint-disable-next-line no-var
  var __solidServerSetup:
    { order: string[]; done: boolean; evaluations: number; httpLoaded?: boolean } | undefined;
}

const state = (globalThis.__solidServerSetup ??= { order: [], done: false, evaluations: 0 });
state.evaluations++;
// Undocumented but stable: the internal modules Node has loaded so far.
state.httpLoaded ??= (process as unknown as { moduleLoadList?: string[] }).moduleLoadList?.includes(
  'NativeModule http',
);
const alreadyLoaded = state.order.length;
await new Promise((resolve) => setTimeout(resolve, 20));
state.order.push(`server-setup(before:${alreadyLoaded})`);
state.done = true;
