import { z } from 'zod';
import * as v from 'valibot';

// The app-mode env schema: a plain object of Standard Schema validators —
// nothing imported from the plugin, and the validator libraries are mixed
// on purpose (zod for the server side, valibot for the client side) to
// prove the Standard Schema seam: any compliant library works, per key.
//
// `server` vars are exposed through virtual:env/server (server module
// graphs only); `client` vars must be VITE_-prefixed and come through
// virtual:env/client. ENV_CHECK_PORT proves the *validated output* is what
// gets baked: no .env entry provides it, so the virtual module must carry
// the coerced/defaulted number 8080, not a raw string.
export default {
  server: {
    SESSION_SECRET: z.string().min(32),
    ENV_CHECK_PORT: z.coerce.number().int().default(8080),
  },
  client: {
    VITE_APP_NAME: v.pipe(v.string(), v.minLength(1)),
  },
};
