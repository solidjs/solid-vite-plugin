// Only ever imported with a query suffix (`./QueryLazy.tsx?variant=a` in
// src/App.tsx): the queried id is the module's whole identity — Rollup keys
// its facade chunk (and the Vite manifest entry) by it, and the dev URL must
// carry it too. Regression fixture for the SSR lazy asset lookup dropping
// module query strings (#299): stripping the query broke the production
// manifest lookup and served the wrong module identity in dev.
export default function QueryLazy() {
  return <p id="query-lazy">QUERY-LAZY-CONTENT</p>;
}
