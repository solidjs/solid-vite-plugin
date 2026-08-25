import { z } from 'zod';

// Fixture for the config-time prefix guard (ENV_SCHEMA=./env.badprefix.ts):
// client vars are baked into the browser bundle, so a client key without
// the public VITE_ prefix must be rejected before anything builds.
export default {
  client: {
    APP_NAME: z.string().min(1),
  },
};
