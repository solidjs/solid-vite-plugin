// Lazily imported with a hand-written, slash-prefixed moduleUrl
// (`lazy(…, undefined, '/src/SlashLazy.tsx')` in src/App.tsx). The compiler
// leaves three-argument calls alone, so the key reaches the asset resolvers
// as written. Regression fixture for #390: dev emitted a protocol-relative
// `//src/…` URL and the production manifest lookup missed.
export default function SlashLazy() {
  return <p id="slash-lazy">SLASH-LAZY-CONTENT</p>;
}
