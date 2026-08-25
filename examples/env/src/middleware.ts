import { env } from 'virtual:env/server';

// Middleware is a server-only module, so importing virtual:env/server here
// is the intended pattern. The suite reads these headers to prove the
// server side sees every var — the secret itself never leaves the server
// (only its length does), and ENV_CHECK_PORT arrives as the schema's
// *validated output* (a defaulted number, not a raw env string).
export default async function envCheck(
  request: Request,
  next: (request?: Request) => Promise<Response>,
) {
  const response = await next();
  response.headers.set('x-env-secret-len', String(env.SESSION_SECRET.length));
  response.headers.set('x-env-port', JSON.stringify(env.ENV_CHECK_PORT));
  response.headers.set('x-env-port-type', typeof env.ENV_CHECK_PORT);
  response.headers.set('x-env-app-name', env.VITE_APP_NAME);
  return response;
}
