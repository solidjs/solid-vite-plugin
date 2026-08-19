// Genuinely server-only code behind the 'use server' module (api.ts): the
// `server-only` marker turns any client-graph import into a build error.
// The dep scanner crawls the RAW import graph — App.tsx → api.ts → here —
// before the directive transform splits it, so the boundary guard must
// tolerate the scan pass or every cold `vite dev` start aborts pre-bundling
// (the dev-mode scan checks in test/run.mjs guard the regression; the ssr
// example's boundary.mjs proves the guard still fires for real graphs).
import 'server-only';

const DB_SECRET = 'SERVER-DB-SECRET-e4f2';

export function dbSecretLength() {
  return DB_SECRET.length;
}
