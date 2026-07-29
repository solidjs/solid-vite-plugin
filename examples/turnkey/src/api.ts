'use server';
// Module-level directive: every export becomes a server function. The client
// build of this module is replaced entirely by references — the secret below
// (and the @solidjs/web import) must never appear in any client asset, which
// test/run.mjs asserts.
import { getRequestEvent, respond } from '@solidjs/web';

const SERVER_ONLY_SECRET = 'SERVER-ONLY-SECRET-c81d';

export async function getServerMessage(name: string) {
  return `hello ${name} from the server`;
}

// Response helper round-trip: respond() pairs a value with HTTP metadata.
// The handler forwards the status and encodes the value; scripted clients
// decode it transparently while no-JS consumers would get the plain JSON
// body.
export async function greet(name: string) {
  return respond({ greeting: `hi ${name}` }, { status: 201 });
}

export async function hasSecret() {
  return SERVER_ONLY_SECRET.length > 0;
}

export async function requestMethod() {
  const event = getRequestEvent();
  return event ? event.request.method : 'no-event';
}

// Probe for the `serverFunctions.configure` e2e: src/serverConfig.ts (when
// pinned into the handler graph) rewrites this exact result and stamps a
// response header — in every other mode the string round-trips untouched.
export async function configureProbe() {
  return 'configure-probe';
}
