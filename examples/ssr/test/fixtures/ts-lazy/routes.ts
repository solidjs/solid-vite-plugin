import { lazy } from 'solid-js';

// Plain `.ts` callsite (#406). Primitive naming is off in the test
// (`solid.sourceNames: false`); the module URL must still be written.
export const Page = lazy(() => import('./page.ts'));
