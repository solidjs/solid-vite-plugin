// Prerender failure fixture (prod mode): vite.config.ts wires this through
// `start.middleware` only when SOLID_SHELL_FAIL=1. The chain throws while
// the build prerenders the shell; the built handler contains that as a
// bodyless 500, and the client-mode build must fail instead of writing the
// 500 to dist/client/index.html.
export default async function shellFailure(): Promise<Response> {
  throw new Error('shell-failure-secret');
}
