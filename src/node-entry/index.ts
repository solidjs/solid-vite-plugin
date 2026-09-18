// The Node server for a start-mode build (emitted as dist/server/node.js by
// `start.node`): serves the client build statically and hands every other
// request to the built handler in ./server.js. Runtime config is
// environment-only — PORT (default 3000) and HOST. Listens when run
// directly; `listener`, `createListener` and `serve` are exported for
// mounting into an existing http server or framework.
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import { handleRequest } from './server.js';
import { sendWebResponse, webRequestFromNode } from '../http.js';

// Baked in at build time by the plugin (the generated header above this
// module's code).
declare const SOLID_NODE_CONFIG: {
  /** Client build directory, relative to this file. */
  clientDir: string;
  /** Hashed-asset directory inside it (served immutable); '' disables. */
  assetsDir: string;
  /** The Vite `base`, stripped from request paths before the static lookup. */
  base: string;
  /** Client start mode: HTML navigations without a file get index.html. */
  spa: boolean;
};

const { clientDir, assetsDir, base, spa } = SOLID_NODE_CONFIG;
const clientRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), clientDir);
const assetsRoot = assetsDir ? path.join(clientRoot, assetsDir) + path.sep : null;
// Only a root-relative base prefixes same-origin paths (cf. joinBase).
const basePrefix = base.startsWith('/') ? base.replace(/\/$/, '') : '';

const MIME: Record<string, string> = {
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.ico': 'image/x-icon',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.txt': 'text/plain; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.wasm': 'application/wasm',
  '.map': 'application/json; charset=utf-8',
};

function isReadRequest(req: IncomingMessage): boolean {
  return req.method === 'GET' || req.method === 'HEAD';
}

/** Sends a regular file from the client build; false when it does not exist. */
async function sendFile(req: IncomingMessage, res: ServerResponse, file: string): Promise<boolean> {
  let stats;
  try {
    stats = await stat(file);
  } catch {
    return false;
  }
  if (!stats.isFile()) return false;
  res.statusCode = 200;
  res.setHeader(
    'Content-Type',
    MIME[path.extname(file).toLowerCase()] ?? 'application/octet-stream',
  );
  res.setHeader('Content-Length', stats.size);
  if (assetsRoot && file.startsWith(assetsRoot)) {
    // Hashed file names: cache forever.
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
  } else {
    res.setHeader('Cache-Control', 'public, max-age=0, must-revalidate');
    res.setHeader('Last-Modified', stats.mtime.toUTCString());
  }
  if (req.method === 'HEAD') {
    res.end();
    return true;
  }
  // pipeline destroys the read stream if the client goes away mid-file.
  await pipeline(createReadStream(file), res).catch(() => res.destroy());
  return true;
}

/** The static file a request path names inside the client build, if any. */
function staticFile(pathname: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  if (basePrefix) {
    if (!decoded.startsWith(basePrefix + '/')) return null;
    decoded = decoded.slice(basePrefix.length);
  }
  // Dot segments (.vite/manifest.json) are not served — like `vite preview`.
  if (decoded.split('/').some((segment) => segment.startsWith('.'))) return null;
  // path.join normalizes `..` segments; anything that resolved outside the
  // client build is not a static file.
  const file = path.join(clientRoot, decoded);
  return file.startsWith(clientRoot + path.sep) ? file : null;
}

export interface ListenerOptions {
  /**
   * Serve the client build (dist/client) before the handler. `false` skips
   * the file lookup and the client-mode index.html fallback — for when a
   * framework (`express.static`) or a CDN owns static files. Default true.
   */
  static?: boolean;
  /** Extra request-event fields, merged over `{ nativeEvent: req }`. */
  event?: (req: IncomingMessage) => Record<string, unknown>;
}

export type Listener = (req: IncomingMessage, res: ServerResponse) => Promise<void>;

/** Builds a `(req, res)` handler; `listener` is `createListener()`. */
export function createListener({
  static: serveStatic = true,
  event,
}: ListenerOptions = {}): Listener {
  return async function listener(req, res) {
    try {
      if (serveStatic && isReadRequest(req)) {
        const pathname = new URL(req.url || '/', 'http://localhost').pathname;
        const file = staticFile(pathname);
        if (file && (await sendFile(req, res, file))) return;
        // Client start mode: history fallback for HTML navigations.
        if (
          spa &&
          (req.headers.accept || '').includes('text/html') &&
          (await sendFile(req, res, path.join(clientRoot, 'index.html')))
        ) {
          return;
        }
      }
      // Pages, the server-function endpoint, middleware — everything else.
      // `nativeEvent` is the raw Node request, readable via getRequestEvent().
      const response = await handleRequest(webRequestFromNode(req, undefined, res), {
        event: { nativeEvent: req, ...event?.(req) },
      });
      await sendWebResponse(res, response);
    } catch (error) {
      console.error(error);
      if (res.headersSent) {
        res.destroy();
      } else {
        res.statusCode = 500;
        res.setHeader('Content-Type', 'text/plain; charset=utf-8');
        res.end('Internal Server Error');
      }
    }
  };
}

/** The default handler: mount it with `http.createServer(listener)`. */
export const listener: Listener = createListener();

/** Creates and starts the server; defaults come from PORT and HOST. */
export function serve({
  port = Number(process.env.PORT || 3000),
  host = process.env.HOST,
  ...options
}: { port?: number; host?: string } & ListenerOptions = {}) {
  const server = createServer(createListener(options));
  server.listen(port, host, () => {
    const address = server.address();
    const bound = typeof address === 'object' && address ? address.port : port;
    console.log(`Listening on http://${host || 'localhost'}:${bound}`);
  });
  return server;
}

// Listen only when this file is the program (`node dist/server/node.js`),
// not when imported for its exports.
if (process.argv[1] && path.resolve(process.argv[1]) === import.meta.filename) serve();
