import { z } from 'zod';

// Fixture for the validation-failure modes (ENV_SCHEMA=./env.fail.ts): no
// .env file or process env provides MISSING_REQUIRED_VAR, so validation
// must fail the build / render the dev error overlay with the per-key
// report.
export default {
  server: {
    MISSING_REQUIRED_VAR: z.string().min(1),
  },
  client: {
    VITE_APP_NAME: z.string().min(1),
  },
};
