// A server function for the node mode (test/run.mjs, SOLID_START_NODE=1 with
// `serverFunctions: true`): the emitted Node entry must dispatch the
// /_server endpoint through the kept dist/server handler while pages stay
// static. In the other modes `serverFunctions` is off and the directive is
// inert — `ping` is then plain client code, and the app behaves identically.
'use server';

export async function ping(name: string) {
  return `pong:${name}`;
}
