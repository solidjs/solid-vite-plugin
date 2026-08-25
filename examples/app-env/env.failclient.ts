import { z } from 'zod';

// Fixture for the client-side validation failure (ENV_SCHEMA=
// ./env.failclient.ts): client values are baked at build time, so a
// missing client var must fail the build with the per-key report — unlike
// server vars, whose validation defers to boot.
export default {
  server: {
    SESSION_SECRET: z.string().min(32),
  },
  client: {
    VITE_APP_NAME: z.string().min(1),
    VITE_MISSING_CLIENT: z.string().min(1),
  },
};
