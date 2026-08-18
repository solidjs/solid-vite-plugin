// Node <-> web-standard request/response bridging shared by the plugin's dev
// middlewares (server functions and SSR). The virtual production handlers
// speak web Request/Response only; this is the node:http glue the dev server
// needs to talk to them.
import type { IncomingMessage, ServerResponse } from 'node:http';
import { Readable } from 'node:stream';

/**
 * `urlPath` overrides `req.url` when the middleware needs to dispatch a
 * different URL than the one node saw — the dev middlewares use it to
 * restore the configured Vite `base` that the dev/preview base middleware
 * stripped, so the handler always sees production-shaped URLs.
 *
 * Handles plain HTTP/1 *and* the HTTP/2 compat API: Vite's dev server uses
 * `http2.createSecureServer({ allowHTTP1: true })` whenever `server.https`
 * is set without a proxy, so under https the middlewares receive
 * `Http2ServerRequest`s. The h2/protocol/abort techniques here are
 * reimplemented from srvx's Node adapter (github.com/h3js/srvx,
 * src/adapters/_node) — reference, not copied code.
 */
export function webRequestFromNode(
  req: IncomingMessage,
  urlPath?: string,
  res?: ServerResponse,
): Request {
  // TLS sockets (https and h2) expose `encrypted`; a Request whose url says
  // http: on a TLS connection breaks secure-cookie logic, absolute
  // redirects, and origin checks in application code.
  const protocol = (req.socket as { encrypted?: boolean } | undefined)?.encrypted
    ? 'https'
    : 'http';
  // HTTP/2 has no Host header — the authority travels in the `:authority`
  // pseudo-header instead.
  const host = req.headers.host ?? (req.headers[':authority'] as string | undefined) ?? 'localhost';
  const url = new URL(urlPath ?? req.url ?? '/', `${protocol}://${host}`);
  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (value === undefined) continue;
    // HTTP/2 pseudo-headers (:method, :path, :authority, :scheme) are not
    // legal field names — Headers#append throws a TypeError on them.
    if (key[0] === ':') continue;
    if (Array.isArray(value)) {
      for (const item of value) headers.append(key, item);
    } else {
      headers.append(key, value);
    }
  }
  // Surface client disconnects as the request's AbortSignal so handlers can
  // cancel work (streamed SSR renders, in-flight fetches). The response's
  // 'close' fires on normal completion too; `writableEnded` distinguishes a
  // finished response from a client that went away.
  let signal: AbortSignal | undefined;
  if (res) {
    const controller = new AbortController();
    res.once('close', () => {
      if (!res.writableEnded) controller.abort();
    });
    signal = controller.signal;
  }
  const method = req.method || 'GET';
  const body =
    method === 'GET' || method === 'HEAD'
      ? undefined
      : (Readable.toWeb(req) as unknown as ReadableStream);
  return new Request(url, {
    method,
    headers,
    body,
    signal,
    // undici requires half-duplex for streamed request bodies.
    ...(body ? { duplex: 'half' } : {}),
  } as RequestInit);
}

export async function sendWebResponse(res: ServerResponse, response: Response): Promise<void> {
  res.statusCode = response.status;
  // set-cookie is the one header that must not be comma-joined.
  const cookies: string[] | undefined = (response.headers as any).getSetCookie?.();
  response.headers.forEach((value, key) => {
    if (key !== 'set-cookie') res.setHeader(key, value);
  });
  if (cookies && cookies.length) res.setHeader('set-cookie', cookies);
  // HEAD gets the head only — and the body must be *cancelled*, not pumped:
  // node discards HEAD body writes, so streaming a long (or endless) body
  // into the void just burns the render. (Technique from srvx.)
  if (!response.body || res.req?.method === 'HEAD') {
    response.body?.cancel().catch(() => {});
    res.end();
    return;
  }
  const reader = response.body.getReader();
  res.on('close', () => {
    reader.cancel().catch(() => {});
  });
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      // A response whose client already went away never emits 'drain'
      // (writes are no-ops), so a backpressure wait must also settle on
      // 'close'/'error' or an aborted streaming response parks this promise
      // — and the reader and Response it holds — forever.
      if (res.destroyed) return;
      if (!res.write(value)) {
        const drained = await new Promise<boolean>((resolve) => {
          const settle = (ok: boolean) => {
            res.off('drain', onDrain);
            res.off('close', onGone);
            res.off('error', onGone);
            resolve(ok);
          };
          const onDrain = () => settle(true);
          const onGone = () => settle(false);
          res.once('drain', onDrain);
          res.once('close', onGone);
          res.once('error', onGone);
        });
        // Client gone mid-stream; the 'close' handler cancels the reader.
        if (!drained) return;
      }
    }
    res.end();
  } catch {
    res.destroy();
  }
}

export function joinBase(base: string, pathname: string): string {
  // Absolute-URL or relative bases (CDN deploys, './') don't prefix
  // same-origin server paths.
  if (!base.startsWith('/')) return pathname;
  return (base.endsWith('/') ? base.slice(0, -1) : base) + pathname;
}
