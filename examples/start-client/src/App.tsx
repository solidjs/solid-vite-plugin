import { createSignal, lazy, Loading } from 'solid-js';
import './App.css';

// A lazy chunk proves code splitting + chunk CSS keep working in SPA mode
// (the chunk loads its own CSS through the preload helper client-side).
const LazySection = lazy(() => import('./LazySection.tsx'));

export default function App() {
  const [count, setCount] = createSignal(0);

  return (
    <main>
      <h1 id="title">Turnkey Client Mode</h1>
      <p id="marker">CLIENT-RENDERED-APP</p>
      <button id="increment" onClick={() => setCount(count() + 1)}>
        Increment
      </button>
      <span id="count">{count()}</span>
      <Loading fallback={<p>loading…</p>}>
        <LazySection />
      </Loading>
    </main>
  );
}
