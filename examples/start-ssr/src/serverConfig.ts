// Server-only runtime configuration, pinned into the
// `virtual:solid-server-function-handler` graph by
// `serverFunctions.configure` (see vite.config.ts, SERVER_FN_CONFIGURE).
// Because the handler graph loads before any dispatch — the dev middleware
// and the production handler both evaluate it first — whatever registers
// here is guaranteed to be in place for the very first server-function
// call, even after a dev-server restart when nothing has rendered yet.
// This is where a router would register its single-flight collector; the
// test uses a `transformResult` hook instead because its effect (a header +
// a transformed value on the probe call) is observable over plain HTTP.
// The /server subpath is the type-correct import for server-only modules:
// the base subpath's types are the client surface, which doesn't declare
// configureServerFunctionsServer.
import { configureServerFunctionsServer } from '@solidjs/web/server-functions/server';
import { respond } from '@solidjs/web';

configureServerFunctionsServer({
  transformResult(_event, result) {
    if (result === 'configure-probe') {
      return respond(`${result}+transformed`, {
        headers: { 'x-configure-module': 'configure-v1' },
      });
    }
    return result;
  },
});
