// Regression fixture for the nested lazy-component SSR convergence loop:
// mirrors @solidjs/router's outlet choreography — a context provider whose
// children re-CREATE lazy() components every time the suspended render pass
// retries (the router's `outlet` is a plain closure, so nested routes
// re-run `createComponent(lazyRoute, …)` per retry). Server-side lazy()
// re-requests its assets on every creation; before the dev asset resolver
// cached per key and answered synchronously once resolved, every retry
// suspended on a brand-new promise, the pass never converged, and the
// render stack overflowed one resume closure per cycle — killing the dev
// server with an escaped rejection. The fs-routing fullstack template hit
// this on any nested route (layout + child) in dev.
import { createComponent, createContext, lazy } from 'solid-js';

const OutletContext = createContext<number>(0);

const LazyLayout = lazy(() => import('./NestedLazyLayout'));
const LazyLeaf = lazy(() => import('./NestedLazyLeaf'));

export default function NestedLazySection() {
  // Mirrors createRouteContext().outlet: each invocation re-creates the
  // component tree, so a retry of the provider's children memo re-requests
  // both lazy modules' assets.
  const outlet = () =>
    createComponent(LazyLayout, {
      get children() {
        return createComponent(LazyLeaf, {});
      },
    });
  return <OutletContext value={1}>{outlet()}</OutletContext>;
}
