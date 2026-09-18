// `start.instrument` (SSR_INSTRUMENT=1, middleware mode): the module the
// plugin awaits to completion before anything else in the server graph
// loads — the seam an APM's OpenTelemetry setup needs (`Sentry.init()`
// must run before the modules it patches are loaded). This fake proves the
// contract without an APM:
// - it evaluates FIRST: nothing from the app graph has run yet, so the
//   ordering register it creates is empty (middleware.ts appends to it at
//   its own module top level, which cannot happen before this line),
// - it is awaited to COMPLETION: real async work here (a timer) finishes
//   before the handler graph is even imported — middleware.ts reads `done`
//   at its top level and finds it true. A static `import './instrument'`
//   would fail this: ESM hoists static imports and evaluates them in
//   dependency order, so the handler's `@solidjs/web` import graph would
//   run before this module's body.
// - it counts evaluations: once per server process (dev and prod), not once
//   per request.
declare global {
  // eslint-disable-next-line no-var
  var __solidInstrument: { order: string[]; done: boolean; evaluations: number } | undefined;
}

const state = (globalThis.__solidInstrument ??= { order: [], done: false, evaluations: 0 });
state.evaluations++;
const alreadyLoaded = state.order.length;
await new Promise((resolve) => setTimeout(resolve, 20));
state.order.push(`instrument(before:${alreadyLoaded})`);
state.done = true;
