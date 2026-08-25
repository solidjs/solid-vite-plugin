import { z } from 'zod';
import * as v from 'valibot';

// Guard fixture: a `server` key whose validator is async (zod async
// refinement — Standard Schema lets validate() return a Promise). Server
// env validates process.env synchronously at boot, because the generated
// module must carry no top-level await (a TLA chunk forces esnext on
// downstream bundle targets — Nitro's node-server preset rejects it), so
// this schema must be rejected at config/build time with the
// async-validator error naming the key. SESSION_SECRET is used on purpose:
// .env provides a valid value, so the sync prefix of the schema passes and
// zod actually goes async — exercising the Promise detection rather than a
// short-circuiting sync failure.
export default {
  server: {
    SESSION_SECRET: z
      .string()
      .min(32)
      .refine(async () => true, { message: 'async refinement' }),
  },
  client: {
    VITE_APP_NAME: v.pipe(v.string(), v.minLength(1)),
  },
};
