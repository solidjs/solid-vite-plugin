// The entire app the user writes for turnkey SSR: a plain content component
// (no <html>, no HydrationScript, no entries — the plugin's generated
// document shell provides all of that). Exercises, for test/run.mjs:
// - hydration + client interactivity (the counter),
// - streaming (the async section renders after the shell),
// - server functions alongside SSR: module-level references (message,
//   method, secret), a function-level "use server" body (double), and the
//   respond() envelope round-trip (greeting),
// - HMR (HmrTarget is edited on disk by the test),
// - CSS handling (App.css must reach the page in dev and prod — inlined in
//   the dev SSR head, linked as a hashed asset in prod),
// - clientOnly (the widget SSRs as its fallback, its chunk gets a
//   modulepreload hint in prod, and the real component swaps in post-settle),
// - the active JSX backend marker (define-injected) for the babel-hmr mode.
// - the response-head lifecycle (paths under /missing, /redirect-pre,
//   /redirect-post, /whoami, /boom — plain-HTTP surfaces for the http and
//   middleware e2e checks; the default path is untouched).
import { createMemo, createSignal, Loading } from 'solid-js';
import { clientOnly, getRequestEvent, httpHeader, httpStatus, isServer } from '@solidjs/web';
import { getServerMessage, greet, hasSecret, requestMethod } from './api';
import HmrTarget from './HmrTarget';
import './App.css';

const OnlyClient = clientOnly(() => import('./ClientOnlyWidget'));

// Injected by the vite config's `define`; names the active JSX backend so
// the e2e can assert which compiler served the page.
declare const __JSX_COMPILER__: string;

// Streams a shell, then writes a redirect Location AFTER the shell is out:
// the head is committed, so the runtime must fall back to the script
// redirect (`<script>window.location=...`) instead of a 3xx.
function LateRedirect() {
  const late = createMemo(async function* () {
    await new Promise((resolve) => setTimeout(resolve, 300));
    if (isServer) {
      // httpHeader() would no-op here (the head is committed); routers write
      // the stub directly for post-flush redirects, so do the same.
      getRequestEvent()!.response.headers.set('Location', '/redirected-target');
    }
    yield 'LATE-REDIRECT-CONTENT';
  });
  return (
    <main>
      <Loading fallback={<p>late…</p>}>
        <p>{late()}</p>
      </Loading>
    </main>
  );
}

export default function App() {
  // Plain-HTTP test surfaces keyed off the path (isomorphic read so the
  // rendered tree can't mismatch if one of them were ever hydrated).
  const pathname = isServer
    ? new URL(getRequestEvent()!.request.url).pathname
    : window.location.pathname;
  if (pathname === '/missing') {
    httpStatus(404);
    httpHeader('x-page', 'missing');
    return <main id="not-found">NOT-FOUND-PAGE</main>;
  }
  if (pathname === '/redirect-pre') {
    // Pre-flush: a Location on the stub must become a real 3xx (no body).
    httpHeader('Location', '/redirected-target');
    return <main>redirecting…</main>;
  }
  if (pathname === '/redirect-post') return <LateRedirect />;
  if (pathname === '/whoami') {
    // Middleware decorates locals before dispatch; the page reads them.
    const user = isServer ? String(getRequestEvent()!.locals.user ?? 'anonymous') : '';
    return <main id="whoami">user:{user}</main>;
  }
  if (pathname === '/boom') {
    // A render throw the error middleware must be able to catch.
    throw new Error('boom-page');
  }

  const [count, setCount] = createSignal(0);
  const [message, setMessage] = createSignal('');
  const [doubled, setDoubled] = createSignal('');
  const [method, setMethod] = createSignal('');
  const [secret, setSecret] = createSignal('');
  const [greeting, setGreeting] = createSignal('');

  // Function-level directive inside a component: the compiler hoists the body
  // to a module-level registration on the server and swaps in a reference on
  // the client. (Bodies must not close over component scope.)
  const double = async (n: number) => {
    'use server';
    return n * 2;
  };

  // Async-generator memo inside a Loading boundary: the SSR shell streams
  // immediately with the fallback, the yielded content follows in a later
  // chunk once it resolves.
  const streamed = createMemo(async function* () {
    await new Promise((resolve) => setTimeout(resolve, 300));
    yield 'STREAMED-ASYNC-CONTENT';
  });

  return (
    <main>
      <h1 id="title">Turnkey SSR</h1>
      <button id="increment" onClick={() => setCount(count() + 1)}>
        count
      </button>
      <p id="count">{count()}</p>
      <button id="call-message" onClick={async () => setMessage(await getServerMessage('client'))}>
        message
      </button>
      <p id="message">{message()}</p>
      <button id="call-double" onClick={async () => setDoubled(String(await double(21)))}>
        double
      </button>
      <p id="doubled">{doubled()}</p>
      <button id="call-method" onClick={async () => setMethod(await requestMethod())}>
        method
      </button>
      <p id="method">{method()}</p>
      <button id="call-secret" onClick={async () => setSecret(String(await hasSecret()))}>
        secret
      </button>
      <p id="secret">{secret()}</p>
      <button
        id="call-respond"
        onClick={async () => {
          // The transport unwraps respond()'s envelope: the caller receives
          // the carried value, not the ResponseEnvelope the source signature
          // declares.
          const result = (await greet('client')) as unknown as { greeting: string };
          setGreeting(result.greeting);
        }}
      >
        respond
      </button>
      <p id="greeting">{greeting()}</p>
      <p id="jsx-compiler">{__JSX_COMPILER__}</p>
      {/* Deliberately BEFORE <HmrTarget />: a hydrated clientOnly used to
          shift the hydration ids of every following sibling (fixed upstream
          in @solidjs/web 2.0.0-beta.31, solidjs/solid @ edb3e36f), so a
          following sibling here keeps the e2e exercising the fixed path —
          the HMR swap of <HmrTarget /> must replace, not duplicate. */}
      <OnlyClient fallback={<p id="client-only-fallback">client-only-fallback</p>} />
      <HmrTarget />
      <Loading fallback={<p id="stream-fallback">streaming…</p>}>
        <p id="streamed">{streamed()}</p>
      </Loading>
    </main>
  );
}
