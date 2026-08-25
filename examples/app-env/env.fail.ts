import { z } from 'zod';

// Fixture for the server-side validation-failure modes
// (ENV_SCHEMA=./env.fail.ts): no .env file or process env provides
// MISSING_REQUIRED_VAR. Server env is runtime env, so a build only WARNS
// (deferred to boot validation) — while dev renders the error overlay with
// the per-key report (dev IS runtime).
export default {
  server: {
    MISSING_REQUIRED_VAR: z.string().min(1),
  },
  client: {
    VITE_APP_NAME: z.string().min(1),
  },
};
