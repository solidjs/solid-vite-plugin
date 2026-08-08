import { env } from 'virtual:env/client';

// Isomorphic app code (SSR + hydration in ssr mode, client-only in client
// mode) may import virtual:env/client anywhere — it carries only the
// public VITE_-prefixed values. `env.VITE_APP_NAME` is fully typed as
// string through the generated solid-env.d.ts.
export default function App() {
  return (
    <main>
      <h1 id="app-name">{env.VITE_APP_NAME}</h1>
      <p id="marker">ENV-APP-OK</p>
    </main>
  );
}
