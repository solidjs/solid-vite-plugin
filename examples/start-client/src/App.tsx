import { createSignal, lazy, Loading } from 'solid-js';
import { ping } from './ping';
import './App.css';

// A lazy chunk proves code splitting + chunk CSS keep working in SPA mode
// (the chunk loads its own CSS through the preload helper client-side).
const LazySection = lazy(() => import('./LazySection.tsx'));

export default function App() {
  const [count, setCount] = createSignal(0);
  const [pong, setPong] = createSignal('');

  return (
    <main>
      <h1 id="title">Client Start Mode</h1>
      <p id="marker">CLIENT-RENDERED-APP</p>
      <button id="increment" onClick={() => setCount(count() + 1)}>
        Increment
      </button>
      <span id="count">{count()}</span>
      {/* node mode: a server-function round-trip over /_server through the
          emitted Node entry (plain client code when serverFunctions is off). */}
      <button id="ping" onClick={async () => setPong(await ping('node'))}>
        Ping
      </button>
      <span id="pong">{pong()}</span>
      <Loading fallback={<p>loading…</p>}>
        <LazySection />
      </Loading>
    </main>
  );
}
