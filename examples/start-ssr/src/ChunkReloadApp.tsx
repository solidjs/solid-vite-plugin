// App root for the chunk-reload mode (SSR_CHUNK_RELOAD): the real App plus a
// button that loads src/ChunkReloadLazy.ts through a dynamic import. The test
// deletes that chunk from the build before clicking, the way a deploy
// replaces it while a page is open.
import { createSignal } from 'solid-js';
import App from './App';

export default function ChunkReloadApp() {
  const [status, setStatus] = createSignal('idle');
  // `await`, not `import().then(onLoad, onError)`: Vite wraps a chained
  // `.then()` in its preload helper too, so that rejection handler would
  // catch the error before `vite:preloadError` fires.
  const load = async () => {
    try {
      const mod = await import('./ChunkReloadLazy');
      setStatus(mod.default());
    } catch {
      setStatus('failed');
    }
  };
  return (
    <>
      <App />
      <button id="load-chunk" onClick={load}>
        Load chunk
      </button>
      <p id="chunk-status">{status()}</p>
    </>
  );
}
