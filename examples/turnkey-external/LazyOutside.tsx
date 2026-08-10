// Lives OUTSIDE the turnkey example's Vite root (its asset key is
// `../turnkey-external/LazyOutside.tsx`) — the sibling-workspace-package
// shape. Regression fixture for dev SSR lazy asset URLs (#298): a
// root-external key can't be served as `"/" + key` (`/../…` normalizes
// wrong in the browser); it needs Vite's `/@fs/` URL on the resolved
// absolute path, base-prefixed like every other module URL.
export default function LazyOutside() {
  return <p id="external-lazy">EXTERNAL-LAZY-CONTENT</p>;
}
