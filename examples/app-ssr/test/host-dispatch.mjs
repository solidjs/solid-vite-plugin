// Host-owned dev dispatch, the `serverFunctions.devMiddleware: false`
// contract: with the plugin's middleware off, a host (a metaframework, or
// an environment plugin like @cloudflare/vite-plugin) loads
// `virtual:solid-server-function-handler` through its own server
// environment and dispatches endpoint requests itself, exactly like
// production. This script emulates that host against the dev server API:
// it side-effect loads the manifest module (the documented host-side step
// covering functions only client code references), loads the handler, and
// dispatches a synthetic request through `handleServerFunctionRequest`.
// Run by test/run.mjs (no-middleware mode) with SERVER_FN_DEV_MIDDLEWARE=0;
// prints HOST-DISPATCH <status> <body> and exits non-zero on mismatch.
// A second dispatch exercises the `options.event` seam on the standalone
// handler: fields spread into the request event (threaded through the
// runtime's createEvent by the generated wrapper), so the function's
// getRequestEvent() sees the host-provided nativeEvent — printed as
// HOST-DISPATCH-NATIVE <status> <body>.
import { createServer } from 'vite';

const server = await createServer({ server: { middlewareMode: true } });
let exitCode = 1;
try {
  // A client transform is what records a module into the server-function
  // manifest (the same signal the browser's module request sends in a real
  // session); it also yields the compiled reference to pull the id from.
  const transformed = await server.transformRequest('/src/api.ts');
  const match = /createServerReference\w*\("(getServerMessage-[^"]*)"/.exec(transformed?.code || '');
  if (!match) throw new Error('could not extract function id from transformed module');

  const runner = server.environments.ssr.runner;
  await runner.import('virtual:solid-server-function-manifest');
  const handler = await runner.import('virtual:solid-server-function-handler');
  // A real host forwards the browser's fetch metadata; the runtime's
  // same-origin protection rejects dispatches without it.
  const response = await handler.handleServerFunctionRequest(
    new Request(
      `http://localhost${handler.endpoint}/${encodeURIComponent(match[1])}?args=${encodeURIComponent('["host"]')}`,
      { method: 'POST', headers: { 'Sec-Fetch-Site': 'same-origin' } },
    ),
  );
  const body = await response.text();
  console.log(`HOST-DISPATCH ${response.status} ${body}`);

  const nativeMatch = /createServerReference\w*\("(nativeAddress-[^"]*)"/.exec(
    transformed?.code || '',
  );
  if (!nativeMatch) throw new Error('could not extract nativeAddress function id');
  const nativeResponse = await handler.handleServerFunctionRequest(
    new Request(
      `http://localhost${handler.endpoint}/${encodeURIComponent(nativeMatch[1])}?args=${encodeURIComponent('[]')}`,
      { method: 'POST', headers: { 'Sec-Fetch-Site': 'same-origin' } },
    ),
    { event: { nativeEvent: { socket: { remoteAddress: '198.51.100.7' } } } },
  );
  const nativeBody = await nativeResponse.text();
  console.log(`HOST-DISPATCH-NATIVE ${nativeResponse.status} ${nativeBody}`);

  exitCode =
    response.status === 200 &&
    body === 'hello host from the server' &&
    nativeResponse.status === 200 &&
    nativeBody === '198.51.100.7'
      ? 0
      : 1;
} catch (error) {
  console.error(error);
} finally {
  await server.close();
}
process.exit(exitCode);
