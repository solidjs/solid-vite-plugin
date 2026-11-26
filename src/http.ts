// Node <-> web-standard request/response bridging shared by the plugin's dev
// and preview middlewares (server functions and SSR) and by the Node server
// entry `start.nodeServer` emits into users' builds (src/node-entry). The virtual
// production handlers speak web Request/Response only; this is the node:http
// glue that talks to them. Keep it free of vite and plugin imports — it is
// bundled verbatim into dist/server/node.js.
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
  trustProxy: TrustProxy = false,
): Request {
  // TLS sockets (https and h2) expose `encrypted`; a Request whose url says
  // http: on a TLS connection breaks secure-cookie logic, absolute
  // redirects, and origin checks in application code.
  const protocol =
    forwardedProto(req, trustProxy) ??
    ((req.socket as { encrypted?: boolean } | undefined)?.encrypted ? 'https' : 'http');
  // HTTP/2 has no Host header — the authority travels in the `:authority`
  // pseudo-header instead.
  const host = req.headers.host ?? (req.headers[':authority'] as string | undefined) ?? 'localhost';
  const url = parseRequestTarget(urlPath ?? req.url ?? '/', `${protocol}://${host}`);
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
  // Only attach a body when the request actually carries one. A web Request
  // built by the browser for a bodyless POST has `body === null`, and the
  // runtime keys off that (a present body that decodes to nothing is a 400
  // since @solidjs/web 2.0.0-rc.5) — so an unconditionally attached (empty)
  // stream misparses bodyless calls. HTTP/1 signals a body via
  // Content-Length/Transfer-Encoding (RFC 9112 §6); the h2 compat API sets
  // `stream.endAfterHeaders` when END_STREAM rode the headers frame.
  const h2Stream = (req as { stream?: { endAfterHeaders?: boolean } }).stream;
  const hasBody =
    method !== 'GET' &&
    method !== 'HEAD' &&
    (h2Stream
      ? !h2Stream.endAfterHeaders
      : req.headers['transfer-encoding'] !== undefined ||
        (req.headers['content-length'] !== undefined && req.headers['content-length'] !== '0'));
  const body = hasBody ? (Readable.toWeb(req) as unknown as ReadableStream) : undefined;
  return new Request(url, {
    method,
    headers,
    body,
    signal,
    // undici requires half-duplex for streamed request bodies.
    ...(body ? { duplex: 'half' } : {}),
  } as RequestInit);
}

/**
 * Which peers may set the request scheme with `X-Forwarded-Proto`: `true`
 * trusts any peer, `'loopback'` a proxy on the same host, and a list the
 * peer addresses it names.
 */
export type TrustProxy = boolean | 'loopback' | string[];

function normalizeAddress(address: string): string {
  return address.startsWith('::ffff:') ? address.slice(7) : address;
}

function trustsPeer(trustProxy: TrustProxy, address: string | undefined): boolean {
  if (trustProxy === true) return true;
  if (!trustProxy || !address) return false;
  const peer = normalizeAddress(address);
  if (trustProxy === 'loopback') return peer === '::1' || peer.startsWith('127.');
  return trustProxy.some((trusted) => normalizeAddress(trusted) === peer);
}

function forwardedProto(req: IncomingMessage, trustProxy: TrustProxy): string | undefined {
  if (!trustsPeer(trustProxy, req.socket?.remoteAddress)) return;
  const header = req.headers['x-forwarded-proto'];
  if (typeof header !== 'string') return;
  // The nearest proxy's value is the last one; earlier ones may come from the client.
  const proto = header.split(',').pop()!.trim().toLowerCase();
  return proto === 'https' || proto === 'http' ? proto : undefined;
}

/** Reads a `TrustProxy` from an env value such as `TRUST_PROXY`. */
export function parseTrustProxy(value: string | undefined): TrustProxy {
  const text = value?.trim() ?? '';
  if (text === '' || text === 'false' || text === '0') return false;
  if (text === 'true' || text === '1') return true;
  if (text === 'loopback') return 'loopback';
  return text
    .split(',')
    .map((address) => address.trim())
    .filter(Boolean);
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

// Concatenated, not resolved: `//evil.example/x` would otherwise become the authority.
export function parseRequestTarget(target: string, origin: string): URL {
  return target.startsWith('/')
    ? new URL(new URL(origin).origin + target)
    : new URL(target, origin);
}

export function joinBase(base: string, pathname: string): string {
  // Absolute-URL or relative bases (CDN deploys, './') don't prefix
  // same-origin server paths.
  if (!base.startsWith('/')) return pathname;
  return (base.endsWith('/') ? base.slice(0, -1) : base) + pathname;
}
