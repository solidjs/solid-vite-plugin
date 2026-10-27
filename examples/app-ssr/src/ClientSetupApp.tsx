// App root for the client-setup mode (SSR_CLIENT_SETUP=1): wraps the real
// App and records, in the register src/client-setup.ts creates, when this
// module evaluated and whether the setup module had settled by the time the
// app rendered during hydration.
import { isServer } from '@solidjs/web';
import App from './App';

if (!isServer) globalThis.__solidClientSetup?.order.push('app:module');

export default function ClientSetupApp() {
  if (!isServer) {
    const state = globalThis.__solidClientSetup;
    state?.order.push(`app:render(setupDone:${state.done})`);
  }
  return <App />;
}
