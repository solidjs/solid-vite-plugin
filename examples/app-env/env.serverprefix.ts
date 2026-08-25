import { z } from 'zod';

// Fixture for the config-time server-prefix guard
// (ENV_SCHEMA=./env.serverprefix.ts): Vite bakes every VITE_-prefixed var
// into the browser's import.meta.env regardless of schema side, so a
// prefixed key under `server` can never stay secret and must be rejected
// before anything builds.
export default {
  server: {
    VITE_API_SECRET: z.string().min(8),
  },
};
