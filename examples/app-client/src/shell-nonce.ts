// Prerender nonce fixture (prod mode): vite.config.ts wires this through
// `app.middleware` only when SOLID_SHELL_NONCE=1. The middleware puts a
// CSP nonce on the event while the build prerenders the shell; a nonce baked
// into the static dist/client/index.html would be no nonce at all, so the
// shell must render without it (and the build warns).
import type { AppMiddleware } from '@solidjs/vite-plugin';

const shellNonce: AppMiddleware = (event, next) => {
  event.nonce = 'baked-nonce';
  return next();
};

export default shellNonce;
