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
import { createMemo, createSignal, Loading } from 'solid-js';
import { clientOnly } from '@solidjs/web';
import { getServerMessage, greet, hasSecret, requestMethod } from './api';
import HmrTarget from './HmrTarget';
import './App.css';

const OnlyClient = clientOnly(() => import('./ClientOnlyWidget'));

// Injected by the vite config's `define`; names the active JSX backend so
// the e2e can assert which compiler served the page.
declare const __JSX_COMPILER__: string;

export default function App() {
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
      <HmrTarget />
      <Loading fallback={<p id="stream-fallback">streaming…</p>}>
        <p id="streamed">{streamed()}</p>
      </Loading>
      {/* Deliberately the LAST sibling: in @solidjs/web ≤2.0.0-beta.30 a
          hydrated clientOnly shifts the hydration ids of every FOLLOWING
          sibling (its swap gate held an id-consuming owner the server half
          never minted), so a following sibling's first post-settle re-render
          duplicated instead of replacing — observed as the HMR swap of a
          following <HmrTarget /> leaving the old text in place. Fixed
          upstream in solidjs/solid next @ edb3e36f ("Arm clientOnly's swap
          without an owner so sibling hydration ids stay aligned"); once the
          release after beta.30 lands, move this above <HmrTarget /> so the
          e2e exercises the fixed path. Verified locally: with a @solidjs/web
          built from edb3e36f the reordered layout passes 197/197. */}
      <OnlyClient fallback={<p id="client-only-fallback">client-only-fallback</p>} />
    </main>
  );
}
